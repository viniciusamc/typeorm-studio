Promise.reject(new Error('background connection refused'));

await new Promise((resolve) => setTimeout(resolve, 3_000));

export default {};
