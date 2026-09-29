// Draft shapes, shared by the shell, the server and the feedback text. A page
// is untrusted: nothing beyond a string id and kind may be assumed.
const strings = (v) => v === undefined || (Array.isArray(v) && v.every((s) => typeof s === "string"));
// name and label: null means absent.
const optional = (v) => v === undefined || v === null || typeof v === "string";

const KINDS = {
  choice: (d) => strings(d.value) && strings(d.written),
  text: (d) => typeof d.note === "string",
};

const isObject = (d) => d !== null && typeof d === "object" && !Array.isArray(d);

// A draft of a known kind that has that kind's shape.
export function wellFormed(d) {
  return isObject(d) && typeof d.id === "string" && Object.hasOwn(KINDS, d.kind) && optional(d.name) && optional(d.label) && KINDS[d.kind](d);
}

// A draft of a known kind that does not have that kind's shape.
export const malformed = (d) => isObject(d) && Object.hasOwn(KINDS, d.kind) && !wellFormed(d);
