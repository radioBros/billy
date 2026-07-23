/**
 * Router + auth guard. Protected routes redirect unauthenticated users to
 * /login (preserving the intended path as `redirect`). The session is resolved
 * once on boot (auth store `fetchMe`) before the first protected render, avoiding
 * a guard race.
 */
import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import type { Capabilities } from "@billy/types";
import { useAuthStore } from "@/stores/auth";

const routes: RouteRecordRaw[] = [
  {
    path: "/login",
    name: "login",
    component: () => import("@/pages/Login.vue"),
    meta: { public: true, title: "Sign in" },
  },
  {
    path: "/",
    component: () => import("@/layouts/AppShell.vue"),
    children: [
      {
        path: "",
        name: "dashboard",
        component: () => import("@/pages/Dashboard.vue"),
        meta: { title: "Dashboard" },
      },
      {
        path: "clients",
        name: "clients",
        component: () => import("@/pages/ClientsList.vue"),
        meta: { title: "Clients" },
      },
      {
        path: "clients/new",
        name: "client-new",
        component: () => import("@/pages/ClientsForm.vue"),
        meta: { title: "New client" },
      },
      {
        path: "clients/:id/edit",
        name: "client-edit",
        component: () => import("@/pages/ClientsForm.vue"),
        meta: { title: "Edit client" },
      },
      {
        path: "projects",
        name: "projects",
        component: () => import("@/pages/projects/ProjectsList.vue"),
        meta: { title: "Projects" },
      },
      {
        path: "projects/new",
        name: "project-create",
        component: () => import("@/pages/projects/ProjectForm.vue"),
        meta: { title: "New project" },
      },
      {
        path: "projects/:id/edit",
        name: "project-edit",
        component: () => import("@/pages/projects/ProjectForm.vue"),
        meta: { title: "Edit project" },
      },
      {
        path: "invoices",
        name: "invoices",
        component: () => import("@/pages/invoices/InvoicesList.vue"),
        meta: { title: "Invoices" },
      },
      {
        path: "invoices/new",
        name: "invoice-create",
        component: () => import("@/pages/invoices/InvoiceForm.vue"),
        meta: { title: "New invoice" },
      },
      {
        path: "invoices/:id/edit",
        name: "invoice-edit",
        component: () => import("@/pages/invoices/InvoiceForm.vue"),
        meta: { title: "Edit invoice" },
      },
      {
        path: "invoices/:id",
        name: "invoice-detail",
        component: () => import("@/pages/invoices/InvoiceDetail.vue"),
        meta: { title: "Invoice" },
      },
      {
        path: "quotes",
        name: "quotes",
        component: () => import("@/pages/quotes/QuotesList.vue"),
        meta: { title: "Quotes" },
      },
      {
        path: "quotes/new",
        name: "quote-create",
        component: () => import("@/pages/quotes/QuoteForm.vue"),
        meta: { title: "New quote" },
      },
      {
        path: "quotes/:id/edit",
        name: "quote-edit",
        component: () => import("@/pages/quotes/QuoteForm.vue"),
        meta: { title: "Edit quote" },
      },
      {
        path: "quotes/:id",
        name: "quote-detail",
        component: () => import("@/pages/quotes/QuoteDetail.vue"),
        meta: { title: "Quote" },
      },
      {
        path: "expenses",
        name: "expenses",
        component: () => import("@/pages/expenses/ExpensesList.vue"),
        meta: { title: "Expenses" },
      },
      {
        path: "expenses/new",
        name: "expense-create",
        component: () => import("@/pages/expenses/ExpenseForm.vue"),
        meta: { title: "New expense" },
      },
      {
        path: "expenses/:id/edit",
        name: "expense-edit",
        component: () => import("@/pages/expenses/ExpenseForm.vue"),
        meta: { title: "Edit expense" },
      },
      {
        path: "contracts",
        name: "contracts",
        component: () => import("@/pages/contracts/ContractsList.vue"),
        meta: { title: "Contracts" },
      },
      {
        path: "contracts/new",
        name: "contract-create",
        component: () => import("@/pages/contracts/ContractForm.vue"),
        meta: { title: "New contract" },
      },
      {
        path: "contracts/:id/edit",
        name: "contract-edit",
        component: () => import("@/pages/contracts/ContractForm.vue"),
        meta: { title: "Edit contract" },
      },
      {
        path: "contracts/:id",
        name: "contract-detail",
        component: () => import("@/pages/contracts/ContractDetail.vue"),
        meta: { title: "Contract" },
      },
      {
        path: "time-entries",
        name: "time-entries",
        component: () => import("@/pages/time-entries/TimeEntriesList.vue"),
        meta: { title: "Time entries" },
      },
      {
        path: "time-entries/new",
        name: "time-entry-create",
        component: () => import("@/pages/time-entries/TimeEntryForm.vue"),
        meta: { title: "New time entry" },
      },
      {
        path: "time-entries/:id/edit",
        name: "time-entry-edit",
        component: () => import("@/pages/time-entries/TimeEntryForm.vue"),
        meta: { title: "Edit time entry" },
      },
      {
        path: "subscriptions",
        name: "subscriptions",
        component: () => import("@/pages/subscriptions/SubscriptionsList.vue"),
        meta: { title: "Subscriptions" },
      },
      {
        path: "subscriptions/new",
        name: "subscription-create",
        component: () => import("@/pages/subscriptions/SubscriptionForm.vue"),
        meta: { title: "New subscription" },
      },
      {
        path: "subscriptions/:id/edit",
        name: "subscription-edit",
        component: () => import("@/pages/subscriptions/SubscriptionForm.vue"),
        meta: { title: "Edit subscription" },
      },
      {
        path: "recurring-profiles",
        name: "recurring-profiles",
        component: () => import("@/pages/recurring-profiles/RecurringProfilesList.vue"),
        meta: { title: "Recurring" },
      },
      {
        path: "recurring-profiles/:id",
        name: "recurring-profile-detail",
        component: () => import("@/pages/recurring-profiles/RecurringProfileDetail.vue"),
        meta: { title: "Recurring profile" },
      },
      {
        path: "credit-notes",
        name: "credit-notes",
        component: () => import("@/pages/credit-notes/CreditNotesList.vue"),
        meta: { title: "Credit notes" },
      },
      {
        path: "credit-notes/new",
        name: "credit-note-create",
        component: () => import("@/pages/credit-notes/CreditNoteForm.vue"),
        meta: { title: "New credit note" },
      },
      {
        path: "credit-notes/:id/edit",
        name: "credit-note-edit",
        component: () => import("@/pages/credit-notes/CreditNoteForm.vue"),
        meta: { title: "Edit credit note" },
      },
      {
        path: "credit-notes/:id",
        name: "credit-note-detail",
        component: () => import("@/pages/credit-notes/CreditNoteDetail.vue"),
        meta: { title: "Credit note" },
      },
      {
        path: "proformas",
        name: "proformas",
        component: () => import("@/pages/proformas/ProformasList.vue"),
        meta: { title: "Proforma" },
      },
      {
        path: "proformas/new",
        name: "proforma-create",
        component: () => import("@/pages/proformas/ProformaForm.vue"),
        meta: { title: "New proforma" },
      },
      {
        path: "proformas/:id/edit",
        name: "proforma-edit",
        component: () => import("@/pages/proformas/ProformaForm.vue"),
        meta: { title: "Edit proforma" },
      },
      {
        path: "proformas/:id",
        name: "proforma-detail",
        component: () => import("@/pages/proformas/ProformaDetail.vue"),
        meta: { title: "Proforma" },
      },
      {
        path: "settings/customization",
        name: "settings-customization",
        component: () => import("@/pages/settings/CustomizationPanel.vue"),
        // Requires only AUTHENTICATION: every user reaches Settings for their own
        // "User Settings" tab. The panel shows admin-only tabs by capability, and
        // the admin settings PATCH endpoints stay server-side capability-gated.
        meta: { title: "Settings" },
      },
      {
        path: "settings/accounts",
        name: "settings-accounts",
        component: () => import("@/pages/settings/AccountsPanel.vue"),
        // Sysadmin-only account management. The component guards on isSysadmin and
        // every /accounts endpoint is server-side sysadmin-gated (defence in depth).
        meta: { title: "Accounts" },
      },
    ],
  },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

let sessionResolved = false;

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  // Resolve the session exactly once, before the first protected render.
  if (!sessionResolved) {
    await auth.fetchMe();
    sessionResolved = true;
  }

  const isPublic = to.meta.public === true;
  if (!isPublic && !auth.isAuthenticated) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  // Already signed in but hitting /login → send to dashboard.
  if (isPublic && auth.isAuthenticated && to.name === "login") {
    return { path: "/" };
  }
  // Capability gate: a route may require a capability;
  // an authenticated user lacking it is redirected home rather than shown the page.
  const requiredCap = to.meta.requiresCapability as keyof Capabilities | undefined;
  if (requiredCap && auth.principal?.capabilities[requiredCap] !== true) {
    return { path: "/" };
  }
  return true;
});
