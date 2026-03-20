import fs from 'fs';

const mockResponse = `
Here is the updated file as requested.

\`\`\`typescript
const z = 10;
console.log(z);
\`\`\`

Hope that helps!
`;

const codeBlockRegex = /```[\w]*\n([\s\S]*?)```/g;
let match;
let longestBlock = '';

while ((match = codeBlockRegex.exec(mockResponse)) !== null) {
  if (match[1].length > longestBlock.length) {
    longestBlock = match[1];
  }
}

console.log('Extracted Block:', longestBlock.trim());
