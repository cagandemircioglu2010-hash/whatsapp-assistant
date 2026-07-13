-- `company_source` is a runnable reference schema. In production, map the
-- reporting views below to the company existing tables or API-fed staging tables.
CREATE SCHEMA IF NOT EXISTS company_source;
CREATE SCHEMA IF NOT EXISTS assistant_reporting;

CREATE TABLE company_source.sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at TIMESTAMPTZ NOT NULL,
    amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
    currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'refunded', 'cancelled')),
    customer_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE company_source.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('planned', 'in_progress', 'blocked', 'completed', 'cancelled')),
    owner_name TEXT,
    start_date DATE,
    due_date DATE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE company_source.tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES company_source.projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
    assignee_name TEXT,
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    due_date DATE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sales_occurred_status_idx ON company_source.sales (occurred_at, status);
CREATE INDEX projects_active_idx ON company_source.projects (status, updated_at DESC);
CREATE INDEX tasks_overdue_idx ON company_source.tasks (due_date, status) WHERE status NOT IN ('done', 'cancelled');

CREATE OR REPLACE VIEW assistant_reporting.sales_daily
WITH (security_barrier = true)
AS
SELECT
    (occurred_at AT TIME ZONE 'Europe/Istanbul')::date AS sale_date,
    currency,
    COUNT(*) FILTER (WHERE status = 'completed')::integer AS completed_sales_count,
    COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0)::numeric(14, 2) AS completed_revenue,
    COUNT(*) FILTER (WHERE status = 'refunded')::integer AS refund_count,
    COALESCE(SUM(amount) FILTER (WHERE status = 'refunded'), 0)::numeric(14, 2) AS refunded_amount
FROM company_source.sales
GROUP BY (occurred_at AT TIME ZONE 'Europe/Istanbul')::date, currency;

CREATE OR REPLACE VIEW assistant_reporting.active_projects
WITH (security_barrier = true)
AS
SELECT
    p.id,
    p.name,
    p.department,
    p.status,
    p.owner_name,
    p.start_date,
    p.due_date,
    p.updated_at,
    COUNT(t.id) FILTER (WHERE t.status NOT IN ('done', 'cancelled'))::integer AS open_task_count,
    COUNT(t.id) FILTER (
        WHERE t.status NOT IN ('done', 'cancelled') AND t.due_date < CURRENT_DATE
    )::integer AS overdue_task_count
FROM company_source.projects p
LEFT JOIN company_source.tasks t ON t.project_id = p.id
WHERE p.status IN ('planned', 'in_progress', 'blocked')
GROUP BY p.id, p.name, p.department, p.status, p.owner_name, p.start_date, p.due_date, p.updated_at;

CREATE OR REPLACE VIEW assistant_reporting.overdue_tasks
WITH (security_barrier = true)
AS
SELECT
    t.id,
    t.project_id,
    p.name AS project_name,
    p.department,
    t.title,
    t.status,
    t.assignee_name,
    t.priority,
    t.due_date,
    (CURRENT_DATE - t.due_date)::integer AS days_overdue,
    t.updated_at
FROM company_source.tasks t
JOIN company_source.projects p ON p.id = t.project_id
WHERE t.status NOT IN ('done', 'cancelled')
  AND t.due_date IS NOT NULL
  AND t.due_date < CURRENT_DATE;

COMMENT ON SCHEMA assistant_reporting IS 'The only company schema exposed to the WhatsApp assistant read-only role.';
COMMENT ON VIEW assistant_reporting.sales_daily IS 'Aggregated sales only; customer-level data is intentionally excluded.';
COMMENT ON VIEW assistant_reporting.active_projects IS 'Active project summary with task counts.';
COMMENT ON VIEW assistant_reporting.overdue_tasks IS 'Open tasks whose due date has passed.';
