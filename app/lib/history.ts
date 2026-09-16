'use client';

import Cookies from 'js-cookie';

export type HistoryItemPath =
  | 'Work'
  | 'Checklist'
  | 'Msg'
  | 'Account'
  | 'Employee'
  | 'Reports'
  | 'Settings'
  | 'Customers'
  | 'Orders'
  | 'Subscriptions'
  | 'TimeTracking'
  | 'ClockIn'
  | 'ClockOut'
  | 'WorkScheduleSelected'
  | 'WorkScheduleCreated'
  | 'ChecklistStarted'
  | 'ChecklistEnded'
  | 'ChecklistCreated'
  | 'MessageSent'
  | 'TemplateCreated'
  | 'CarCreated'
  | 'CarUpdated'
  | 'CarKmUpdated'
  | 'CustomerCreated'
  | 'CustomerUpdated'
  | 'CustomerDeleted'
  | 'TemplateViewed'
  | 'SessionDeleted';

export interface HistoryItem {
  id: string;
  path: HistoryItemPath;
  hDateTime: string;
  usrId: string;
}

export const saveHistory = (id: string, path: HistoryItemPath, usrId: string): void => {
  const now = new Date();
  const formattedDateTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}  Time:  ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const newItem: HistoryItem = {
    id: id.toString(),
    path,
    hDateTime: formattedDateTime,
    usrId: usrId.toString(),
  };
  const currentHistory = getHistory(usrId);
  const updatedHistory = [
    newItem,
    ...currentHistory.filter(item => item.id !== newItem.id || item.path !== newItem.path),
  ].slice(0, 5);

  Cookies.set('userHistory', JSON.stringify(updatedHistory), { expires: 30, path: '/' });
};

export const getHistory = (userId: string | null): HistoryItem[] => {
  try {
    const historyCookie = Cookies.get('userHistory');
    if (!historyCookie) return [];

    const allHistoryItems: HistoryItem[] = JSON.parse(historyCookie);
    return userId
      ? allHistoryItems.filter(item => item.usrId === userId)
      : allHistoryItems;
  } catch {
    return [];
  }
};
