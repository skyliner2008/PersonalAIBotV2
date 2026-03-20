const textWithCRLF = "Here is the code:\n\n```typescript\r\nconst a = 1;\r\n```\n\nDONE";
const oldRegex = /```[\w]*\n([\s\S]*?)```/g;
const newRegex = /```[\w]*\r?\n([\s\S]*?)```/g;

console.log("Old Regex Match:", oldRegex.exec(textWithCRLF));
console.log("New Regex Match:", newRegex.exec(textWithCRLF));
