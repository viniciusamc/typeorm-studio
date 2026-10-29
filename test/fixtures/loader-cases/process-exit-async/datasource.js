setTimeout(() => process.exit(4), 10);

await new Promise((resolve) => setTimeout(resolve, 3_000));

export default {};
