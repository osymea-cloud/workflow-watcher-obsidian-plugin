import { buildTemplateDocument, buildWorkflowTemplate } from "../src/engine";
// 如果 planSidecarPair 在这个文件里，一并 import
// import { planSidecarPair } from "../src/路径/到/你的文件";

const now = new Date("2026-11-02T00:00:00Z");

// ① 看 buildTemplateDocument({ now })
const document = buildTemplateDocument({ now });
console.log("===== buildTemplateDocument({ now }) =====");
console.log(JSON.stringify(document, null, 2));

// ② 看 buildWorkflowTemplate({ includeRenderBlock: false, now })
const noteMarkdown = buildWorkflowTemplate({ includeRenderBlock: false, now });
console.log("\n===== buildWorkflowTemplate(...) =====");
console.log(noteMarkdown);

// ③ 如果 planSidecarPair 不依赖 Obsidian，看它的输出
// const pair = planSidecarPair(MAIN_BOARD_PATH, noteMarkdown, document);
// console.log("\n===== planSidecarPair =====");
// console.log("sidecarPath:", pair.sidecarPath);
// console.log("jsonText:\n", pair.jsonText);
// console.log("noteMarkdown:\n", pair.noteMarkdown);