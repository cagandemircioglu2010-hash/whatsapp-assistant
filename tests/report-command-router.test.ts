import { describe, expect, it } from "vitest";
import { AuthorizationService } from "../src/auth/authorization.service.js";
import type { PermissionLookup } from "../src/auth/permission.repository.js";
import type { AuthorizedUser } from "../src/auth/types.js";
import type {
  ActiveProject,
  CompanyReports,
  OverdueTask,
  SalesSummary
} from "../src/reports/company-report.repository.js";
import { ReportCommandRouter } from "../src/reports/report-command-router.js";

const user: AuthorizedUser = { id: "user-1", fullName: "Test User", department: "Sales", role: "employee" };

class FakePermissions implements PermissionLookup {
  constructor(private readonly allowed: boolean) {}
  async has(): Promise<boolean> {
    return this.allowed;
  }
}

class FakeReports implements CompanyReports {
  lastProjectDepartment: string | undefined;
  async getSalesSummary(input: { startDate: string; endDate: string }): Promise<SalesSummary> {
    return {
      ...input,
      currencies: [
        {
          currency: "TRY",
          completedSalesCount: 4,
          completedRevenue: "12000.00",
          refundCount: 0,
          refundedAmount: "0.00"
        }
      ],
      generatedAt: new Date().toISOString()
    };
  }
  async getActiveProjects(input: { limit?: number; department?: string } = {}): Promise<ActiveProject[]> {
    this.lastProjectDepartment = input.department;
    return [
      {
        id: "project-1",
        name: "Portal",
        department: "Engineering",
        status: "in_progress",
        ownerName: null,
        startDate: null,
        dueDate: null,
        openTaskCount: 3,
        overdueTaskCount: 1,
        updatedAt: new Date().toISOString()
      }
    ];
  }
  async getOverdueTasks(): Promise<OverdueTask[]> {
    return [];
  }
}

describe("report command router", () => {
  it("runs an authorized sales summary", async () => {
    const router = new ReportCommandRouter(
      new FakeReports(),
      new AuthorizationService(new FakePermissions(true)),
      "Europe/Istanbul"
    );
    const result = await router.handle(user, "SATIŞ ÖZETİ");
    expect(result.outcome).toBe("success");
    expect(result.resource).toBe("company.sales");
    expect(result.text).toContain("4 tamamlanan satış");
  });

  it("does not query protected data without permission", async () => {
    const router = new ReportCommandRouter(
      new FakeReports(),
      new AuthorizationService(new FakePermissions(false)),
      "Europe/Istanbul"
    );
    const result = await router.handle(user, "aktif projeler");
    expect(result).toEqual({
      outcome: "denied",
      resource: "company.projects",
      resources: ["company.projects"],
      text: "Bu bilgiye erişim yetkiniz bulunmuyor."
    });
  });

  it("forces employee project queries into the employee department", async () => {
    const reports = new FakeReports();
    const router = new ReportCommandRouter(
      reports,
      new AuthorizationService(new FakePermissions(true)),
      "Europe/Istanbul"
    );
    await router.handle(user, "aktif projeler");
    expect(reports.lastProjectDepartment).toBe("Sales");
  });
});
