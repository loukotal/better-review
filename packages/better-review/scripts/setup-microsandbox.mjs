import { install, isInstalled } from "microsandbox";

if (isInstalled()) {
  console.log("Microsandbox runtime is already installed.");
} else {
  await install();
  console.log("Microsandbox runtime installed.");
}
