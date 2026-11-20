import { writeFileSync } from "node:fs";
import { buildWidgetModule, generatedWidgetPath } from "./widget-bundle";

async function main() {
  const output = await buildWidgetModule();
  writeFileSync(generatedWidgetPath, output);
  console.log(
    `Wrote ${generatedWidgetPath} (${Math.round(output.length / 1024)} KB)`,
  );
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
