import { buildTemplateDocument, buildTemplateNoteSection } from "../src/engine";

const now = new Date("2026-11-02T00:00:00Z");
const document = buildTemplateDocument({ title: "调试流程", now });

const noteSection = buildTemplateNoteSection(document);

console.log("---- document.workflows[0].root ----");
console.log(JSON.stringify(document.workflows[0].root, null, 2));

console.log("---- noteSection ----");
console.log(noteSection);

console.log("---- noteSection (escaped) ----");
console.log(JSON.stringify(noteSection));