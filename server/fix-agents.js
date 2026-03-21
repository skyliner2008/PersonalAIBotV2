const fs = require('fs');
const walk = (dir) => {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = dir + '/' + file;
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else if (file.endsWith('.ts')) {
      results.push(file);
    }
  });
  return results;
};
const files = walk('src');
for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  if (content.includes('new Agent(')) {
    content = content.replace(/new Agent\([^)]+\)/g, 'new Agent()');
    fs.writeFileSync(file, content, 'utf8');
    console.log('Fixed', file);
  }
}
