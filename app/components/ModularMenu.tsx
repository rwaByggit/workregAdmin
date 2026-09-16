'use client';
import { useState, useEffect, ReactNode, useCallback, Children, useMemo } from 'react';
import type { JSX } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  Home,  Settings,  Users,  Columns,  Settings2Icon,Workflow,
  Bell,  UserCircle,  ChevronDown,  LogOut,
  LucideIcon,  ChartArea,
  MessageSquare,  CirclePlay,  Menu,  NotebookTabs,  User,
  Car, Truck, Clock, CreditCard, ImageIcon, KeyRound
} from 'lucide-react';
import MenuItem from './MenuItem';
import Link from 'next/link';
import PageVersionFooter from './PageVersionFooter';
import { useSession, signOut } from 'next-auth/react';
import type { Session } from 'next-auth';
import { saveHistory, HistoryItem, getHistory, HistoryItemPath } from '@/app/lib/history';
import { toast } from "sonner";
import { useUnsavedChanges } from '@/app/context/unsavedChangesContext';
// Import the centralized hook for selected account
import useSelectedAccount, { SelectedAccount as HookSelectedAccountType } from '../../app/hooks/useSelectedAccount';
import { useModuleAccess } from '@/app/hooks/useModuleAccess';
import { MODULE_TABLE_MAPPINGS } from '@/lib/module-table-mapping';
import { getIsCaravanTourHost, TOUR_HOST_SIMULATION_CHANGED_EVENT } from '@/app/lib/tour-host-simulation';
import SubscriptionAccessNotice from '@/app/components/SubscriptionAccessNotice';

interface Module {
  id: string;
  path: string;
  title: string;
  icon: LucideIcon;
  description: string;
}

interface Account {
  account_id: string;
  access_level?: number;
  tblaccount: {
    name: string | null;
  };
}

interface ModularMenuProps {
  children: ReactNode;
}

// Add this custom type to extend the default Session type
interface CustomSession extends Session {
  user?: {
    id?: string;
    isSystemAdmin?: boolean;
    name?: string | null;
    email?: string | null;
    image?: string | null;
    accounts?: {
      id: string;
      name: string;
      rights: number;
    }[];
  };
}

const moduleIcons: Record<string, LucideIcon> = {
  dashboard: Home,
  clockin: Clock,
  worktemplate: Settings2Icon,
  Checklist: Workflow,
  workorder: Truck,
  customer: Users,
  carpool: Car,
  'rental-order': KeyRound,
  reports: ChartArea,
  gallery: ImageIcon,
  messages: MessageSquare,
  profile: User,
  settings: CreditCard,
  admin: Settings,
  dbadmin: Columns,
};

// Module menu entries are generated from the subscription mapping so new modules
// only need to be registered in lib/module-table-mapping.ts.
const modules: Module[] = MODULE_TABLE_MAPPINGS.map((module) => ({
  id: module.moduleId,
  path: module.modulePath,
  title: module.moduleName,
  icon: moduleIcons[module.moduleId] ?? Menu,
  description: module.description,
}));

// Helper function to render message content with clickable markdown links
const renderMessageContent = (content: string, router: ReturnType<typeof useRouter>) => {
  // Match markdown links: [text](url)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let match;

  while ((match = linkRegex.exec(content)) !== null) {
    // Add text before the link
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    // Add the link
    const linkText = match[1];
    const linkUrl = match[2];
    parts.push(
      <Link
        key={match.index}
        href={linkUrl}
        className="text-blue-600 hover:text-blue-800 underline font-medium"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        {linkText}
      </Link>
    );
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts.length > 0 ? parts : content;
};

const isModuleActive = (pathname: string | null, module: Module) => {
  if (!pathname) return false;
  return pathname === module.path || pathname.startsWith(`${module.path}/`);
};

const ModularMenu: React.FC<ModularMenuProps> = ({ children }) => {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession() as {
    data: CustomSession | null;
    status: 'loading' | 'authenticated' | 'unauthenticated';
  };
  
  const [currentTitle, setCurrentTitle] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Use the centralized selected-account hook (handles localStorage + broadcasting)
  const { account: storedAccount, setSelectedAccount } = useSelectedAccount();
  const [showDropdown, setShowDropdown] = useState<boolean>(false);
  const [showProfileMenu, setShowProfileMenu] = useState<boolean>(false);
  const [showAddNewModal, setShowAddNewModal] = useState(false);
  const [isCreatingAccount, setIsCreatingAccount] = useState<boolean>(false);
  const [newAccount, setNewAccountName] = useState("");
  const [showMessages, setShowMessages] = useState(false);
  const [expandedMessage, setExpandedMessage] = useState<string | null>(null);
  const [unreadMessages, setUnreadMessages] = useState<any[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [messagesFetchError, setMessagesFetchError] = useState(false);
  const [pendingSubscriptionPayment, setPendingSubscriptionPayment] = useState<boolean | null>(null);
  const isAuthenticated = sessionStatus === 'authenticated' && Boolean(session?.user?.id);
  const [isCaravanHost, setIsCaravanHost] = useState(false);
  // Track client mount to avoid hydration mismatch when reading localStorage/window.
  const [mounted, setMounted] = useState(false);
  const isPublicSubscriptionHost =
    mounted &&
    typeof window !== 'undefined' &&
    (window.location.hostname === 'caravan.just4us.no' ||
      window.location.hostname === 'work.just4us.no') &&
    pathname === '/';
  const isPublicPage = pathname?.startsWith('/newsubscription') || isPublicSubscriptionHost;
  const selectedAccountId = storedAccount?.account_id ? Number(storedAccount.account_id) : null;
  const { canAccessModule, isLoading: isMenuAccessLoading } = useModuleAccess({
    accountId: selectedAccountId,
    userAccessLevel: storedAccount?.access_level,
  });

  useEffect(() => {
    if (!isAuthenticated) {
      setPendingSubscriptionPayment(false);
      return;
    }

    let cancelled = false;

    const checkPendingSubscriptionPayment = async () => {
      try {
        const response = await fetch('/api/subscription/pending-payment', { cache: 'no-store' });
        if (!response.ok) return;

        const data = await response.json();
        if (!cancelled) {
          setPendingSubscriptionPayment(Boolean(data.payment));
        }
      } catch (error) {
        console.error('Unable to check pending subscription payment:', error);
      }
    };

    checkPendingSubscriptionPayment();
    const interval = setInterval(checkPendingSubscriptionPayment, 15000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isAuthenticated]);

  const menuAccessModuleIds = useMemo(
    () => new Set(MODULE_TABLE_MAPPINGS.map(module => module.moduleId)),
    []
  );

  // Filter modules based on user permissions
  const filteredModules = useMemo(() => {
    return modules.filter((module) => {
      // Keep the dashboard available so the user can complete a pending payment.
      if (pendingSubscriptionPayment === true) {
        return module.id === 'dashboard';
      }

      // Only show admin and database admin to the system admin user.
      if (module.id === 'dbadmin' || module.id === 'admin') {
        return session?.user?.isSystemAdmin === true;
      }

      // Profile is always available to authenticated users.
      if (module.id === 'profile') {
        return true;
      }

      const isManagedBySubscription = menuAccessModuleIds.has(module.id);
      if (!isManagedBySubscription) {
        return true;
      }

      if (!selectedAccountId || isMenuAccessLoading) {
        return false;
      }

      return canAccessModule(module.id);
    });
  }, [canAccessModule, isMenuAccessLoading, menuAccessModuleIds, pendingSubscriptionPayment, selectedAccountId, session?.user?.isSystemAdmin]);

  const activePathModule = useMemo(() => {
    if (!pathname) return null;
    return modules.find(module => isModuleActive(pathname, module)) || null;
  }, [pathname]);

  const activeRestrictedModule = useMemo(() => {
    if (
      isPublicPage ||
      !activePathModule ||
      pathname === '/checklist' ||
      !selectedAccountId ||
      isMenuAccessLoading ||
      !menuAccessModuleIds.has(activePathModule.id)
    ) {
      return null;
    }

    if (activePathModule.id === 'profile' || activePathModule.id === 'admin' || activePathModule.id === 'dbadmin') {
      return null;
    }

    return canAccessModule(activePathModule.id) ? null : activePathModule;
  }, [activePathModule, canAccessModule, isMenuAccessLoading, isPublicPage, menuAccessModuleIds, pathname, selectedAccountId]);

  // Get the unsaved changes context
  const { hasUnsavedChanges, confirmNavigation, UnsavedChangesDialog } = useUnsavedChanges();

  // Fetch unread messages
  const fetchUnreadMessages = useCallback(async () => {
    // Don't fetch before the user is logged in and an account is selected.
    if (!isAuthenticated || !storedAccount) {
      return;
    }

    setIsLoadingMessages(true);
    setMessagesFetchError(false);
    try {
      const response = await fetch('/api/messages/unread');
      if (response.ok) {
        const data = await response.json();
        setUnreadMessages(data.data || []);
        setMessagesFetchError(false);
      } else if (response.status === 401) {
        setUnreadMessages([]);
        setMessagesFetchError(false);
      } else {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('Failed to fetch unread messages:', response.status, errorData);
        setMessagesFetchError(true);
        setUnreadMessages([]);
      }
    } catch (error) {
      console.error('Error fetching unread messages:', error);
      setMessagesFetchError(true);
      setUnreadMessages([]);
    } finally {
      setIsLoadingMessages(false);
    }
  }, [isAuthenticated, storedAccount]);

  useEffect(() => {
    // mark mounted on client to avoid rendering client-only values during SSR
    setMounted(true);

    const syncCaravanHost = () => {
      setIsCaravanHost(getIsCaravanTourHost());
    };

    syncCaravanHost();
    window.addEventListener(TOUR_HOST_SIMULATION_CHANGED_EVENT, syncCaravanHost);

    return () => {
      window.removeEventListener(TOUR_HOST_SIMULATION_CHANGED_EVENT, syncCaravanHost);
    };
  }, []);

  useEffect(() => {
    if (!mounted || isPublicPage || sessionStatus === 'loading') {
      return;
    }

    if (sessionStatus === 'unauthenticated') {
      const redirect = pathname && pathname !== '/dashboard'
        ? `?redirect=${encodeURIComponent(pathname)}`
        : '';
      router.replace(`/login${redirect}`);
      return;
    }

    if (!session?.user?.id) {
      setSelectedAccount(null);
      signOut({ redirect: false }).finally(() => {
        router.replace('/login');
      });
    }
  }, [isPublicPage, mounted, pathname, router, session?.user?.id, sessionStatus, setSelectedAccount]);

  // Fetch unread messages when account is available and set up polling
  useEffect(() => {
    if (!isAuthenticated || !storedAccount) {
      setUnreadMessages([]);
      setMessagesFetchError(false);
      setIsLoadingMessages(false);
      return;
    }

    // Fetch unread messages when account is available
    fetchUnreadMessages();

    // Set up polling to check for new messages every 30 seconds
    const interval = setInterval(fetchUnreadMessages, 30000);

    return () => clearInterval(interval);
  }, [fetchUnreadMessages, isAuthenticated, storedAccount]);

  const toggleMessages = () => {
    if (!showMessages) {
      // Refresh messages when opening the dropdown
      fetchUnreadMessages();
    }
    setShowMessages(!showMessages);
    setExpandedMessage(null);
  };

  const expandMessage = async (bellId: string) => {
    setExpandedMessage(expandedMessage === bellId ? '' : bellId);

    // Mark the message as read when clicked
    try {
      const response = await fetch('/api/messages/mark-read', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messageId: bellId }),
      });

      if (response.ok) {
        // Remove the message from unread list after marking as read
        setUnreadMessages(prev => prev.filter(msg => msg.id !== bellId));
      } else {
        console.error('Failed to mark message as read');
      }
    } catch (error) {
      console.error('Error marking message as read:', error);
    }
  };

  // Fetch user accounts
  const fetchAccounts = async (userId: string | undefined) => {
    if (!userId) return;
    console.log("👉 modularmenu  calls app/api/user/[id]/account - route.ts | Returning account");
    try {
      const res = await fetch(`/api/user/${userId}/account`);
      const data: Account[] = await res.json();
      setAccounts(data);

      if (userId && data.length > 0) {
        console.log("👉 MM: 129 set account:", data);

        // Check localStorage for selected account (the hook will still be used to set the selected account)
        const storedAccountString = typeof window !== 'undefined' ? localStorage.getItem('selectedAccount') : null;
        if (storedAccountString) {
          try {
            const parsed: Account = JSON.parse(storedAccountString);
            const foundAccount = data.find(account => account.account_id === parsed.account_id);

            if (foundAccount) {
              // Use hook to set selected account (hook handles localStorage + broadcasting)
              setSelectedAccount(foundAccount);
              toast.info(`Last account "${foundAccount.tblaccount?.name ?? foundAccount.account_id}" is selected. Returned from history.`);
              console.log("✅ MM: Selected account from localStorage:", foundAccount);
            } else {
              console.log("❌ Stored account not found in fetched data.");
              if (data.length > 0) {
                setSelectedAccount(data[0]);
                // hook already writes to localStorage
                toast.info("Choosen account in top bar is done");
                console.log("✅ MM: Selected first account:", data[0]);
              }
            }
          } catch (error) {
            console.error("Error parsing stored account:", error);
            if (data.length > 0) {
              setSelectedAccount(data[0]);
            }
          }
        } else {
          if (data.length > 0) {
            setSelectedAccount(data[0]);
          }
        }
      }
    } catch (error) {
      console.error("Could not fetch accounts:", error);
    }
  };

  const handleCreateAccount = async () => {
    setIsCreatingAccount(true);
    try {
      const res = await fetch('/api/account/createAccount', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountName: newAccount }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create account');
      }

      const newAccountId = data.newAccount?.id?.toString();
      if (!newAccountId) {
        throw new Error('Created account was not returned by the server');
      }

      saveHistory(newAccountId, 'Account', session?.user?.id?.toString() || '');
      await fetchAccounts(session?.user?.id);
      setShowAddNewModal(false);
      setNewAccountName('');
      setShowDropdown(false);
      router.refresh();
    } catch (error) {
      console.log(error);
    } finally {
      setIsCreatingAccount(false);
    }
  };

  // Navigation handler that checks current path
  const handleNavigation = (path: string) => {
    // Don't navigate if we're already on this page
    if (pathname === path) {
      return;
    }

    if (hasUnsavedChanges) {
      confirmNavigation(() => router.push(path));
    } else {
      router.push(path);
    }
  };

  useEffect(() => {
    const storedAccountString = typeof window !== 'undefined' ? localStorage.getItem('selectedAccount') : null;
    console.log("useEffect loading storedAccountString ", storedAccountString);
  }, []);

  useEffect(() => {
    if (session?.user?.id) {
      const fetchAndSelectAccount = async () => {
        try {
          if (!session) return;
          const usrId = session?.user?.id || null;
          const res = await fetch(`/api/user/${usrId}/account`);
          const data: Account[] = await res.json();
          setAccounts(data);
          console.log("✅ MM:  account from api:", data);
          if (data.length > 0) {
            // Try to load from history first
            const storedHistory = getHistory(usrId);
            if (storedHistory && storedHistory.length > 0) {
              const lastAccountHistory = storedHistory[0];
              if (lastAccountHistory && lastAccountHistory.id) {
                const foundAccount = data.find(account => account.account_id === lastAccountHistory.id);
                if (foundAccount) {
                  setSelectedAccount(foundAccount);
                  // hook persists to localStorage
                  console.log("✅ MM: Selected account from history:", foundAccount);
                  toast.success(`Selected account "${foundAccount.tblaccount?.name ?? foundAccount.account_id}" successfully based on history.`);
                  return;
                }
              }
            }

            // If no history or history account not found, try localStorage
            const storedAccountString = typeof window !== 'undefined' ? localStorage.getItem('selectedAccount') : null;
            if (storedAccountString) {
              try {
                const parsed: Account = JSON.parse(storedAccountString);
                const foundAccount = data.find(account => account.account_id === parsed.account_id);
                if (foundAccount) {
                  setSelectedAccount(foundAccount);
                  console.log("✅ Selected account from localStorage:", foundAccount);
                  return;
                }
              } catch (error) {
                console.error("Error parsing stored account:", error);
              }
            }

            // If neither history nor localStorage, select the first account
            setSelectedAccount(data[0]);
            console.log("✅ Selected first account:", data[0]);
          }
        } catch (error) {
          console.error("Could not fetch accounts:", error);
        }
      };

      fetchAndSelectAccount();
    }
  }, [session, session?.user?.id, setSelectedAccount]);

  useEffect(() => {

    // Find the module that matches the current path
    if (pathname) {
      const activeModule = filteredModules.find(module => isModuleActive(pathname, module));
      if (activeModule) {
        const title = isCaravanHost && activeModule.id === 'dashboard' ? 'Caravan Host' : activeModule.title;
        setCurrentTitle(title);
        document.title = title;
      } else if (pathname.startsWith('/pipeline/')) {
        setCurrentTitle("Pipeline-Stage Builder");
        document.title = 'Pipeline-Stage';
      } else if (pathname.startsWith('/checklist/session/')) {
        setCurrentTitle("Checklist Session");
        document.title = 'Checklist Session';
      } else if (pathname.startsWith('/checklist/templates/')) {
        setCurrentTitle("Checklist Template");
        document.title = 'Checklist Template';
      } else if (pathname.startsWith('/receipts/templates/')) {
        setCurrentTitle("Receipt Template");
        document.title = 'Receipt Template';
      } else if (pathname.startsWith('/workorder')) {
        setCurrentTitle("Work Order");
        document.title = 'Work Order';
      } else {
        // Handle cases where the path doesn't match a module (e.g., 404 page)
        if(isCaravanHost){ 
          setCurrentTitle("Caravan Host");
          document.title = "Caravan Host";
        } else {
          setCurrentTitle("WorkReg");
          document.title = "WorkReg";
        }
      }
    }
  }, [pathname, filteredModules, isCaravanHost]);

  if (!isPublicPage && (sessionStatus === 'loading' || !isAuthenticated)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background-alt">
        <div className="text-center text-neutral">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p>Loading session...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background-alt">
      {/* Sidebar - Hidden on public pages */}
      {!isPublicPage && (
        <div className="w-16 hover:w-64 bg-white shadow-md transition-all duration-200 flex flex-col gap-1 p-2">
          {filteredModules.map((module) => {
            const showPendingPaymentDashboardTooltip =
              pendingSubscriptionPayment === true && module.id === 'dashboard';
            const menuModule = showPendingPaymentDashboardTooltip
              ? { ...module, description: 'access more by fulfill payment' }
              : module;

            return (
              <MenuItem
                key={module.id}
                module={menuModule}
                isActive={isModuleActive(pathname, module)}
                onClick={() => handleNavigation(module.path)}
                descriptionClassName={showPendingPaymentDashboardTooltip ? 'text-red-600' : undefined}
              />
            );
          })}
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Top Bar - Hidden on public pages */}
        {!isPublicPage && (
          <div className="bg-white shadow-sm p-4 flex justify-between items-center relative">
          <h1 className="text-xl font-heading font-bold text-accent">{currentTitle}</h1>
          <div className="flex items-center gap-4">
            {/* Notifications */}
            <div id="bell-notifications" className="relative">
              <button
                className="p-2 hover:bg-primary/10 rounded-full transition-colors"
                onClick={toggleMessages}
                title={messagesFetchError ? "Failed to load messages" : "Notifications"}
              >
                <Bell className={`w-6 h-6 ${messagesFetchError ? 'text-yellow-500' : 'text-neutral'}`} />
                {messagesFetchError ? (
                  <span className="absolute -top-1 -right-1 bg-yellow-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
                    ?
                  </span>
                ) : unreadMessages.length > 0 ? (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                    {unreadMessages.length}
                  </span>
                ) : null}
              </button>
              {showMessages && (
                <div className="absolute right-0 mt-2 bg-white shadow-lg rounded-lg w-80 py-1 z-50 max-h-96 overflow-y-auto">
                  <div className="flex justify-between items-center px-4 py-2 border-b">
                    <h3 className="font-semibold">Unread Messages</h3>
                    <button
                      onClick={() => {
                        setShowMessages(false);
                        router.push('/admin/messages?tab=history');
                      }}
                      className="text-sm text-blue-600 hover:text-blue-800"
                    >
                      View All
                    </button>
                  </div>
                  {isLoadingMessages ? (
                    <div className="px-4 py-8 text-center text-gray-500">
                      Loading messages...
                    </div>
                  ) : messagesFetchError ? (
                    <div className="px-4 py-8 text-center">
                      <div className="text-yellow-600 mb-2">
                        <Bell className="w-8 h-8 mx-auto mb-2" />
                        <p className="font-semibold">Failed to load messages</p>
                      </div>
                      <button
                        onClick={fetchUnreadMessages}
                        className="text-sm text-blue-600 hover:text-blue-800 underline"
                      >
                        Try again
                      </button>
                    </div>
                  ) : unreadMessages.length === 0 ? (
                    <div className="px-4 py-8 text-center text-gray-500">
                      No unread messages
                    </div>
                  ) : (
                    <ul>
                      {unreadMessages.map((message) => (
                        <li
                          key={message.id}
                          className="px-4 py-3 hover:bg-primary/10 cursor-pointer border-b last:border-b-0"
                          onClick={() => expandMessage(message.id)}
                        >
                          <div className="flex justify-between items-start mb-1">
                            <strong className="text-sm font-semibold">
                              {message.subject || 'No Subject'}
                            </strong>
                            <span className="text-xs text-gray-500">
                              {new Date(message.sent_at).toLocaleDateString()}
                            </span>
                          </div>
                          {message.sender && (
                            <p className="text-xs text-gray-600 mb-1">
                              From: {message.sender.name || message.sender.email}
                            </p>
                          )}
                          {expandedMessage === message.id ? (
                            <div className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">
                              {renderMessageContent(message.message_content, router)}
                            </div>
                          ) : (
                            <p className="text-sm text-gray-600 line-clamp-2">
                              {message.message_content}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* Accounts Dropdown */}
            <div id="account-selector" className="relative">
              <button
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-background-alt hover:bg-yellow-100"
                onClick={() => setShowDropdown(!showDropdown)}
              >
                {/* Avoid using client-only storedAccount value during SSR.
                    Only render the localStorage-derived account name after mount to prevent hydration mismatch. */}
                <span className="text-accent font-medium">
                  {mounted && (storedAccount as any)?.tblaccount?.name
                    ? (storedAccount as any).tblaccount.name
                    : "Select Account"}
                </span>
                <ChevronDown className="w-4 h-4 text-neutral" />
              </button>

              {showDropdown && (
                <div className="absolute right-0 mt-2 bg-white shadow-lg rounded-lg w-48 py-1 z-50">
                  {accounts.map((account) => (
                    <button
                      key={account.account_id}
                      className="w-full px-4 py-2 text-left hover:bg-primary/10 transition-colors"
                      onClick={() => {
                        // Only check for unsaved changes if we're selecting a different account
                        const isNewAccount = !(storedAccount) || account.account_id.toString() !== (storedAccount as any).account_id?.toString();

                        if (!isNewAccount) {
                          // Same account, just close dropdown
                          setShowDropdown(false);
                          return;
                        }

                        const doSwitch = () => {
                          // Use centralized hook to set the account (hook handles localStorage/broadcast)
                          setSelectedAccount(account as unknown as HookSelectedAccountType);
                          console.log("💾 dropdown: account set:", account);
                          saveHistory(account.account_id, 'Account', session?.user?.id?.toString() || '');
                          setShowDropdown(false);
                          router.push('/dashboard');
                          toast.success(`Account "${account.tblaccount.name}" selected`);
                        };

                        if (hasUnsavedChanges) {
                          // Show confirmation before changing account
                          confirmNavigation(doSwitch);
                        } else {
                          // No unsaved changes, switch accounts directly
                          doSwitch();
                        }
                      }}
                    >
                      {account.tblaccount.name}
                    </button>
                  ))}
                  <hr /> {/* Separator */}

                  <button
                    id='btnAddNewAcc'
                    className="w-full px-4 py-2 text-left hover:bg-primary/10 transition-colors"
                    onClick={() => {
                      const addBtn = document.getElementById("btnAddNewAcc");
                      if (!addBtn) { return; }
                      addBtn.style.display = 'none';
                      setShowAddNewModal(true);
                    }}
                  >
                    -- Add New --
                  </button>
                  {showAddNewModal && (
                    <div className="flex justify-center items-center">
                      <div className="bg-white rounded-lg p-4">
                        <h6 className="text-blue-500 text-sm">Name for new Account</h6>
                        <input
                          type="text"
                          placeholder="Account Name"
                          value={newAccount}
                          onChange={(e) => setNewAccountName(e.target.value)}
                          className="w-full border rounded px-2 py-1 mb-2"
                        />
                        <div className="flex justify-end">
                          <button
                            onClick={() => { console.log("handleCreateAccount()"); setIsCreatingAccount(true); handleCreateAccount(); }}
                            className="bg-primary text-white rounded px-2 py-1 hover:bg-primary-dark transition-colors disabled:opacity-50 mr-2"
                          >
                            {isCreatingAccount ? "Creating..." : "Create"}
                          </button>
                          <button
                            onClick={() => {
                              setShowAddNewModal(false);
                              const addBtn = document.getElementById("btnAddNewAcc");
                              if (!addBtn) { return; }
                              addBtn.style.display = 'block';
                              setIsCreatingAccount(false);
                            }}
                            className="bg-gray-200 rounded px-2 py-1 hover:bg-gray-300 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Profile Section with Dropdown */}
            <div className="relative">
              <div
                className="flex items-center gap-2 cursor-pointer"
                onClick={() => setShowProfileMenu(!showProfileMenu)}
              >
                <UserCircle className="w-8 h-8 text-gray-600" />
                <span className="text-gray-700 font-medium">{session?.user?.name || "User"}</span>
                <ChevronDown className="w-4 h-4 text-gray-600" />
              </div>

              {/* Profile Dropdown Menu */}
              {showProfileMenu && (
                <div className="absolute right-0 mt-2 bg-white rounded-md shadow-lg w-48 z-50">
                  <div
                    className="px-4 py-2 cursor-pointer hover:bg-gray-100 flex items-center gap-2"
                    onClick={() => {
                      // Only show confirmation if current path is not already /profile
                      if (pathname !== '/profile' && hasUnsavedChanges) {
                        confirmNavigation(() => {
                          router.push('/profile');
                          setShowProfileMenu(false);
                        });
                      } else if (pathname !== '/profile') {
                        // No changes or already on profile page
                        router.push('/profile');
                        setShowProfileMenu(false);
                      } else {
                        // Already on profile page, just close the menu
                        setShowProfileMenu(false);
                      }
                    }}
                  >
                    <Settings2Icon size={16} />
                    Profile Settings
                  </div>
                  <div
                    className="px-4 py-2 cursor-pointer hover:bg-gray-100 text-red-600 flex items-center gap-2"
                    onClick={async () => {
                      if (hasUnsavedChanges) {
                        confirmNavigation(async () => {
                          // clear selected account via hook
                          setSelectedAccount(null);
                          await signOut({ redirect: false });
                          router.push('/login');
                        });
                      } else {
                        // No unsaved changes, logout directly
                        setSelectedAccount(null);
                        await signOut({ redirect: false });
                        router.push('/login');
                      }
                    }}
                  >
                    <LogOut size={16} />
                    Logout
                  </div>
                </div>
              )}
            </div>
          </div>
          </div>
        )}

        {/* Main Content */}
        <div className={`flex-1 ${isPublicPage ? 'p-0' : 'p-6 pb-0'}`}>
          {/* The key attribute holds the id of the selected account.
              This helps React efficiently update/re-render the component when selectedAccount changes.
              If selectedAccount?.account_id is null or undefined, it defaults to "0".
              Account ID 0 represent an invalid account because the first account is added to the database with id 1.
              */}
          <div className={isPublicPage ? "" : "bg-white rounded-lg shadow-sm"} key={(storedAccount as any)?.account_id || "0"}>
            {/* React forces a re-render everytme the key attribute of the parrent changes (because the user select a different account), */}
            {activeRestrictedModule ? (
              <div className="p-6">
                <SubscriptionAccessNotice
                  denial={{
                    title: 'Feature not included',
                    message: `Your current subscription does not include ${activeRestrictedModule.title}.`,
                    moduleId: activeRestrictedModule.id,
                    moduleName: activeRestrictedModule.title,
                    actionLabel: 'Contact an administrator to upgrade the subscription or change your access.',
                  }}
                />
              </div>
            ) : (
              Children.map(children, (child) => {
                return child;
              })
            )}
          </div>
          {/* Version Footer */}
          {!isPublicPage && <PageVersionFooter />}
        </div>
      </div>
    </div>
  );
};

export default ModularMenu;
