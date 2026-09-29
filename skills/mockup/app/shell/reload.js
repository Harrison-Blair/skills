// Held reloads (later task). Returns true when a new `show` for the same
// page should wait instead of reloading the frame now.
export function holdReload(showing, drafts) {
  return false;
}
