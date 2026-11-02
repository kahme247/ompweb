// Test stub for components/ui/toast.tsx: the DOM-backed toast must never fire
// inside these tests. Calls are
// recorded so tests can assert what the user was told.
export const toastCalls = [];
export const toast = {
  success(...args) { toastCalls.push(["success", ...args]); },
  error(...args) { toastCalls.push(["error", ...args]); },
  info(...args) { toastCalls.push(["info", ...args]); },
  close() {},
};
export default toast;
