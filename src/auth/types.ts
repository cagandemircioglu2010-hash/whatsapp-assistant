export type AuthorizedUser = {
  id: string;
  department: string | null;
  role: string;
  // Preferred notice language; absent/null falls back to ASSISTANT_LOCALE.
  locale?: "tr" | "en" | null;
};

export type PermissionAction = "read" | "write" | "approve";

export const reportResources = {
  sales: "company.sales",
  projects: "company.projects",
  tasks: "company.tasks"
} as const;
