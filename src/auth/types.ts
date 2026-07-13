export type AuthorizedUser = {
  id: string;
  fullName: string;
  department: string | null;
  role: string;
};

export type PermissionAction = "read" | "write" | "approve";

export const reportResources = {
  sales: "company.sales",
  projects: "company.projects",
  tasks: "company.tasks"
} as const;
