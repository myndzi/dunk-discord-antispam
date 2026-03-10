const ts = () => new Date().toISOString();
export const logger = (tag: string) => ({
  info(...args: any[]) {
    console.log(100, `${ts()} [${tag}]`, ...args);
  },
  error(...args: any[]) {
    console.error(999, `${ts()} [${tag}]`, ...args);
  },
});
