// Module-level runtime singleton — standard OpenClaw plugin pattern
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runtime: any = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setDashbotRuntime(next: any) {
  runtime = next
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getDashbotRuntime(): any {
  if (!runtime) {
    throw new Error("DashBot runtime not initialized")
  }
  return runtime
}
