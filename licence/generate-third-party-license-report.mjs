import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const lockPath = path.join(root, "package-lock.json");
const pkgPath = path.join(root, "package.json");
const outDir = path.join(root, "licence");

if (!fs.existsSync(lockPath)) {
  throw new Error("package-lock.json not found");
}
if (!fs.existsSync(pkgPath)) {
  throw new Error("package.json not found");
}

const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const rootPkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const lockPackages = lock.packages || {};

const directProd = new Set(Object.keys(rootPkg.dependencies || {}));
const directDev = new Set(Object.keys(rootPkg.devDependencies || {}));
const directPeer = new Set(Object.keys(rootPkg.peerDependencies || {}));

const criteriaMap = {
  "Apache-2.0": [
    "Include a copy of the Apache License 2.0 in redistributions.",
    "Preserve copyright, attribution, and license notices.",
    "Preserve NOTICE file content when present.",
    "Mark modified files with prominent change notices.",
    "Be aware of patent termination on patent litigation."
  ],
  MIT: [
    "Include the MIT copyright notice.",
    "Include the MIT permission notice/license text in redistributions.",
    "No copyleft requirement; derivative works can be differently licensed."
  ],
  "BSD-3-Clause": [
    "Retain copyright notice, license conditions, and disclaimer in source.",
    "Reproduce copyright notice, conditions, and disclaimer in binary distribution docs/materials.",
    "Do not use contributor names to endorse/promote derivatives without prior permission."
  ]
};

function normalizeLicense(value) {
  if (!value) {
    return "UNKNOWN";
  }

  if (typeof value === "string") {
    return value.trim() || "UNKNOWN";
  }

  if (typeof value === "object" && value.type) {
    return String(value.type).trim() || "UNKNOWN";
  }

  return "UNKNOWN";
}

function getRepository(manifest) {
  const repo = manifest.repository;
  if (!repo) {
    return "";
  }

  if (typeof repo === "string") {
    return repo;
  }

  if (typeof repo === "object" && typeof repo.url === "string") {
    return repo.url;
  }

  return "";
}

function findLicenseFiles(moduleDir) {
  if (!fs.existsSync(moduleDir)) {
    return [];
  }

  let names = [];
  try {
    names = fs.readdirSync(moduleDir);
  } catch {
    return [];
  }

  return names.filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name)).sort();
}

function dependencyKind(name, lockEntry) {
  if (directProd.has(name)) {
    return "direct-prod";
  }

  if (directDev.has(name)) {
    return "direct-dev";
  }

  if (directPeer.has(name)) {
    return "direct-peer";
  }

  const parts = ["transitive"];
  if (lockEntry.dev) {
    parts.push("dev");
  } else {
    parts.push("prod");
  }
  if (lockEntry.optional) {
    parts.push("optional");
  }

  return parts.join("-");
}

const records = [];
for (const lockKey of Object.keys(lockPackages)) {
  if (!lockKey.startsWith("node_modules/")) {
    continue;
  }

  const lockEntry = lockPackages[lockKey] || {};
  const moduleDir = path.join(root, lockKey);
  const manifestPath = path.join(moduleDir, "package.json");

  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      manifest = {};
    }
  }

  const name = manifest.name || lockKey.replace(/^node_modules\//, "");
  const version = manifest.version || lockEntry.version || "UNKNOWN";
  const license = normalizeLicense(manifest.license || lockEntry.license);
  const description = manifest.description || "";
  const homepage = manifest.homepage || "";
  const repository = getRepository(manifest);
  const source = homepage || repository || "";
  const licenseFiles = findLicenseFiles(moduleDir).map((f) => `${lockKey}/${f}`);
  const kind = dependencyKind(name, lockEntry);
  const criteria = criteriaMap[license] || [
    "Review the upstream license text and comply with attribution and redistribution requirements.",
    "Record exceptions and legal approvals for non-standard licenses before distribution."
  ];

  records.push({
    name,
    version,
    license,
    dependencyKind: kind,
    description,
    homepage,
    repository,
    source,
    packagePath: lockKey,
    lockfile: {
      resolved: lockEntry.resolved || "",
      integrity: lockEntry.integrity || ""
    },
    licenseFiles,
    criteria
  });
}

records.sort((a, b) => {
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) {
    return byName;
  }
  return a.version.localeCompare(b.version);
});

const countsByLicense = {};
for (const rec of records) {
  countsByLicense[rec.license] = (countsByLicense[rec.license] || 0) + 1;
}

const generatedAt = new Date().toISOString();
const reportJson = {
  generatedAt,
  packageCount: records.length,
  licenses: countsByLicense,
  criteriaByLicense: criteriaMap,
  packages: records
};

fs.writeFileSync(
  path.join(outDir, "third-party-licenses.json"),
  `${JSON.stringify(reportJson, null, 2)}\n`
);

const md = [];
md.push("# Third-Party License Report");
md.push("");
md.push(`Generated: ${generatedAt}`);
md.push(`Total packages: ${records.length}`);
md.push("Note: license criteria are compliance-oriented summaries and are not legal advice.");
md.push("");
md.push("## License Breakdown");
md.push("");
for (const [license, count] of Object.entries(countsByLicense).sort((a, b) => a[0].localeCompare(b[0]))) {
  md.push(`- ${license}: ${count}`);
}
md.push("");
md.push("## License Criteria");
md.push("");
for (const license of Object.keys(countsByLicense).sort()) {
  const criteria = criteriaMap[license] || [
    "Review the full upstream license and satisfy attribution/redistribution requirements."
  ];
  md.push(`### ${license}`);
  for (const item of criteria) {
    md.push(`- ${item}`);
  }
  md.push("");
}

md.push("## Package Inventory");
md.push("");
md.push("| Package | Version | License | Dependency | Criteria Summary |");
md.push("| --- | --- | --- | --- | --- |");
for (const rec of records) {
  const summary = rec.criteria.join(" ").replace(/\|/g, "/");
  md.push(`| \`${rec.name}\` | \`${rec.version}\` | \`${rec.license}\` | \`${rec.dependencyKind}\` | ${summary} |`);
}
md.push("");

md.push("## Package Detail Records");
md.push("");
for (const rec of records) {
  md.push(`### ${rec.name}@${rec.version}`);
  md.push(`- License: ${rec.license}`);
  md.push(`- Dependency kind: ${rec.dependencyKind}`);
  md.push(`- Description: ${rec.description || "N/A"}`);
  md.push(`- Homepage: ${rec.homepage || "N/A"}`);
  md.push(`- Repository: ${rec.repository || "N/A"}`);
  md.push(`- Source URL: ${rec.source || "N/A"}`);
  md.push(`- Package path: ${rec.packagePath}`);
  md.push(`- Lockfile resolved: ${rec.lockfile.resolved || "N/A"}`);
  md.push(`- Lockfile integrity: ${rec.lockfile.integrity || "N/A"}`);
  md.push(`- License files: ${rec.licenseFiles.length ? rec.licenseFiles.join(", ") : "N/A"}`);
  md.push("- License criteria:");
  for (const item of rec.criteria) {
    md.push(`  - ${item}`);
  }
  md.push("");
}

fs.writeFileSync(path.join(outDir, "THIRD_PARTY_LICENSES.md"), md.join("\n"));

console.log("wrote licence/third-party-licenses.json");
console.log("wrote licence/THIRD_PARTY_LICENSES.md");
