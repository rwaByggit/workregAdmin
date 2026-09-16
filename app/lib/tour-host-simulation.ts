'use client';

export type TourHostSimulation = 'work.just4us.no' | 'caravan.just4us.no';

export const DEV_TOUR_HOST_STORAGE_KEY = 'workreg_devTourHostSimulation';
export const WORK_TOUR_HOST: TourHostSimulation = 'work.just4us.no';
export const CARAVAN_TOUR_HOST: TourHostSimulation = 'caravan.just4us.no';
export const TOUR_HOST_SIMULATION_CHANGED_EVENT = 'workreg:tour-host-simulation-changed';
const DEV_HOSTNAMES = new Set(['localhost', '127.0.0.1', 'devwork.just4us.no']);

export function isDevEnvironment() {
  if (process.env.NODE_ENV !== 'production') return true;
  if (typeof window === 'undefined') return false;

  return DEV_HOSTNAMES.has(window.location.hostname);
}

export function isTourHostSimulation(value: string | null): value is TourHostSimulation {
  return value === WORK_TOUR_HOST || value === CARAVAN_TOUR_HOST;
}

export function getStoredTourHostSimulation(): TourHostSimulation {
  if (typeof window === 'undefined') return WORK_TOUR_HOST;

  const storedSimulation = localStorage.getItem(DEV_TOUR_HOST_STORAGE_KEY);
  return isTourHostSimulation(storedSimulation) ? storedSimulation : WORK_TOUR_HOST;
}

export function getEffectiveTourHostname(): string {
  if (typeof window === 'undefined') return WORK_TOUR_HOST;

  return isDevEnvironment() ? getStoredTourHostSimulation() : window.location.hostname;
}

export function getIsCaravanTourHost(): boolean {
  return getEffectiveTourHostname() === CARAVAN_TOUR_HOST;
}

export function setStoredTourHostSimulation(host: TourHostSimulation) {
  if (typeof window === 'undefined') return;

  localStorage.setItem(DEV_TOUR_HOST_STORAGE_KEY, host);
  window.dispatchEvent(new CustomEvent(TOUR_HOST_SIMULATION_CHANGED_EVENT, { detail: { host } }));
}
