/**
 * Clipboard (bridge 1.4). `write` needs no declaration; `read` needs
 * `permissions.clipboard` and shows a host prompt the user confirms. Both
 * need the app window focused (call them from a user action). Imported as
 * `clipboard` from the SDK index.
 */
import { request } from "./index";

export function write(text: string) {
  return request<null>("clipboard.write", { text });
}

export function read() {
  return request<{ text: string }>("clipboard.read");
}
