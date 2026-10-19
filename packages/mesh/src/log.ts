// The service's log lines go to stdout, which the isolated-service hosts write to their log file.
export function log(scope: string) {
  return (message: string) => console.log(`${new Date().toISOString()} ocmesh.${scope} ${message}`)
}
