const NAME = /^(?!\/|.*(\.\.|\/\/|@\{|\\|\s|[~^:?*[])|.*\/$|.*\.lock$|.*\.$)[^\x00-\x1f\x7f]+$/;

/** A cheap check of git's branch-name rules so the button can wait; git has the last word. */
export const validBranchName = (name: string): boolean => NAME.test(name) && !name.startsWith("-");
