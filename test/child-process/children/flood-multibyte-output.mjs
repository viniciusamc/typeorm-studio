// 1 + 160000 + 1 bytes: the last 65536 start in the middle of a two-byte character.
process.stdout.write(`x${'é'.repeat(80_000)}y`);
