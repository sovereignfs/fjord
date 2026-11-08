/**
 * How the app says when. One form, so a person does not have to work out whether `11/4/2026` is April or November: `4 Nov 2026`, and with the time `4 Nov 2026, 22:56 UTC`.
 * What the server draws is in UTC and says so, because the server does not know where the reader is and the browser must draw the same text when it takes over; what only a
 * browser draws (`localMomentText`) is in the reader's own time.
 */
const day = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
const moment = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});
const local = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export const dayText = (time: number | Date | string): string => day.format(new Date(time));
export const momentText = (time: number | Date | string): string =>
  `${moment.format(new Date(time))} UTC`;
export const localMomentText = (time: number | Date | string): string =>
  local.format(new Date(time));
