import { validatePackage, ValidatorInputError } from "./validate.js";

const [packagePath, option] = process.argv.slice(2);
if (!packagePath || (option && option !== "--json")) {
  console.error("Usage: agentbench-validate <package.zip> [--json]");
  process.exitCode = 2;
} else {
  try {
    const report = await validatePackage(packagePath);
    const label =
      report.package_type === "full_provenance"
        ? "Full Provenance Package"
        : "Standard Package";
    console.log(
      option === "--json"
        ? JSON.stringify(report)
        : report.valid
          ? `${label} is valid (verification level: ${report.verification_level}; items: ${report.counts.items})`
          : `${label} is invalid (verification level: ${report.verification_level}; errors: ${report.errors.join(", ")})`,
    );
    if (!report.valid) {
      console.error(report.errors.join(", "));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Package validation failed",
    );
    process.exitCode = error instanceof ValidatorInputError ? 2 : 3;
  }
}
