const lineCount = 4_000;
let text = '';
for (let index = 0; index < lineCount; index += 1) {
  text += `line-${String(index).padStart(6, '0')}${'x'.repeat(88)}\n`;
}
process.stdout.write(text);
