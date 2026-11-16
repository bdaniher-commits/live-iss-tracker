/**
 * Calendar (bridge 1.3). Needs `permissions.calendar`; create/update/delete
 * need `access: "readwrite"` and only touch events this app created
 * (`mine: true`). Imported as `calendar` from the SDK index.
 */
import { request } from "./index";

export interface CalendarEventInput {
  title?: string;
  notes?: string | null;
  location?: string | null;
  /** ISO 8601. */
  start_at?: string;
  end_at?: string | null;
  all_day?: boolean;
  timezone?: string;
  rrule?: string | null;
  color?: string | null;
}

export interface CalendarEvent extends Required<CalendarEventInput> {
  id: string;
  occurrence_start?: string;
  occurrence_end?: string;
  /** Created by this app — only those can be updated or deleted. */
  mine: boolean;
}

export function list(range: { from: string; to: string; expand?: boolean }) {
  return request<{ items: CalendarEvent[] }>("calendar.list", range);
}

export function create(event: CalendarEventInput & { title: string; start_at: string }) {
  return request<CalendarEvent>("calendar.create", event);
}

export function update(id: string, changes: CalendarEventInput) {
  return request<CalendarEvent>("calendar.update", { ...changes, id });
}

function remove(id: string) {
  return request<null>("calendar.delete", { id });
}
export { remove as delete };
