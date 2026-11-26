if (process.argv[2] === "--semantic") {
  const { evaluateSemantic } = await import("./semantic.mjs");
  await evaluateSemantic(process.argv.slice(3));
} else {
  await import("./historical.mjs");
}
