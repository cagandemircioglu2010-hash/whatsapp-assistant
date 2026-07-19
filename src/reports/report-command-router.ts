import type { AuthorizedUser } from "../auth/types.js";
import type { AssistantContext, AssistantResponder, AssistantResponse } from "../assistant/types.js";
import { reportResources } from "../auth/types.js";
import { AuthorizationService, PermissionDeniedError } from "../auth/authorization.service.js";
import type { CompanyReports } from "./company-report.repository.js";

function normalizeTurkish(input: string): string {
  return input
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .trim();
}

function localIsoDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function salesDateRange(timezone: string): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 6 * 86_400_000);
  return { startDate: localIsoDate(start, timezone), endDate: localIsoDate(end, timezone) };
}

function formatMoney(amount: string, currency: string): string {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return `${amount} ${currency}`;
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency }).format(numeric);
}

const crossDepartmentRoles = new Set(["manager", "executive", "admin"]);

const MENU_TRIGGERS = new Set(["menu", "menü", "yardim", "help", "komut", "komutlar", "?"]);

// Fixed numeric shortcuts so "1" always means the same report, no matter
// which subset the user is permitted to see.
const MENU_ITEMS: Array<{ shortcut: string; resource: string; label: string; command: string }> = [
  { shortcut: "1", resource: reportResources.sales, label: "Satış özeti (son 7 gün)", command: "satis ozeti" },
  { shortcut: "2", resource: reportResources.projects, label: "Aktif projeler", command: "aktif projeler" },
  { shortcut: "3", resource: reportResources.tasks, label: "Geciken görevler", command: "geciken gorevler" }
];

function departmentScope(user: AuthorizedUser, resource: string): string | undefined {
  if (crossDepartmentRoles.has(user.role.toLowerCase())) return undefined;
  if (!user.department) throw new PermissionDeniedError(resource);
  return user.department;
}

function safeDisplayText(value: string, maxLength = 120): string {
  return value
    .replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export class ReportCommandRouter implements AssistantResponder {
  constructor(
    private readonly reports: CompanyReports,
    private readonly authorization: AuthorizationService,
    private readonly timezone: string
  ) {}

  async handle(
    user: AuthorizedUser,
    incomingText: string,
    _context?: AssistantContext
  ): Promise<AssistantResponse> {
    let command = normalizeTurkish(incomingText);

    if (MENU_TRIGGERS.has(command)) {
      return this.menu(user);
    }
    const shortcut = MENU_ITEMS.find((item) => item.shortcut === command);
    if (shortcut) command = shortcut.command;

    try {
      if (command.includes("satis")) {
        await this.authorization.require(user.id, reportResources.sales);
        const range = salesDateRange(this.timezone);
        const summary = await this.reports.getSalesSummary(range);
        const lines = summary.currencies.length
          ? summary.currencies.map(
              (item) =>
                `• ${item.completedSalesCount} tamamlanan satış — ${formatMoney(item.completedRevenue, item.currency)}`
            )
          : ["Bu tarih aralığında tamamlanan satış bulunamadı."];
        return {
          resource: reportResources.sales,
          resources: [reportResources.sales],
          outcome: "success",
          text: `Son 7 gün satış özeti (${summary.startDate} – ${summary.endDate}):\n${lines.join("\n")}`
        };
      }

      if (command.includes("proje") && (command.includes("aktif") || command.includes("durum"))) {
        await this.authorization.require(user.id, reportResources.projects);
        const department = departmentScope(user, reportResources.projects);
        const projects = await this.reports.getActiveProjects({
          limit: 10,
          ...(department ? { department } : {})
        });
        const lines = projects.length
          ? projects.map(
              (project) =>
                `• ${safeDisplayText(project.name)} — ${safeDisplayText(project.status)}, ${project.openTaskCount} açık görev, ${project.overdueTaskCount} gecikmiş`
            )
          : ["Aktif proje bulunamadı."];
        return {
          resource: reportResources.projects,
          resources: [reportResources.projects],
          outcome: "success",
          text: `Aktif projeler:\n${lines.join("\n")}`
        };
      }

      if (command.includes("gecik") && command.includes("gorev")) {
        await this.authorization.require(user.id, reportResources.tasks);
        const department = departmentScope(user, reportResources.tasks);
        const tasks = await this.reports.getOverdueTasks({
          limit: 10,
          ...(department ? { department } : {})
        });
        const lines = tasks.length
          ? tasks.map(
              (task) =>
                `• ${safeDisplayText(task.title)} (${safeDisplayText(task.projectName)}) — ${task.daysOverdue} gün, ${safeDisplayText(task.priority, 20)}`
            )
          : ["Geciken görev bulunamadı."];
        return {
          resource: reportResources.tasks,
          resources: [reportResources.tasks],
          outcome: "success",
          text: `Geciken görevler:\n${lines.join("\n")}`
        };
      }
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        return {
          text: error.message,
          resource: error.resource,
          resources: [error.resource],
          outcome: "denied"
        };
      }
      throw error;
    }

    return {
      resource: null,
      resources: [],
      outcome: "unsupported",
      text: "Şu anda desteklenen sorgular: “satış özeti”, “aktif projeler” ve “geciken görevler”. Menü için “menü” yazın."
    };
  }

  // Permission-aware menu: only reports the user can actually read are
  // listed, each with its stable numeric shortcut.
  private async menu(user: AuthorizedUser): Promise<AssistantResponse> {
    const permitted: string[] = [];
    for (const item of MENU_ITEMS) {
      if (await this.authorization.isAllowed(user.id, item.resource)) {
        permitted.push(`${item.shortcut}. ${item.label}`);
      }
    }
    if (permitted.length === 0) {
      return {
        resource: null,
        resources: [],
        outcome: "denied",
        text: "Hesabınıza henüz rapor izni tanımlanmamış. Lütfen yöneticinizle iletişime geçin."
      };
    }
    return {
      resource: null,
      resources: [],
      outcome: "success",
      text: `Kullanabileceğiniz raporlar:\n${permitted.join("\n")}\n\nRapor için numarasını veya adını yazmanız yeterli.`
    };
  }
}
