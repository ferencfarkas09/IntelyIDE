import { describe, expect, it } from "vitest";
import { createMockNamespaces } from "../../ipc/namespaces";
import { PREVIEW_FIXTURE_FILES, seedPreviewFixture } from "../../ipc/mock/preview";
import { classify, dedupeByLink, detectKind, expoPages, filterPages, loadCatalog, pageForFile, parsePages, resolveImport, sortPages } from "./catalog";

const ADMIN = `import React from 'react';
import { Redirect } from "react-router";
import Loadable, { loadWithRetry } from "../loadablePage";

const RedirectToCRMLeads = () => <Redirect to="/crm/leads" />;
const Layout = Loadable(() => import(/* webpackChunkName: "layout-adminLayout" */ './../../components/layouts/adminLayout/Layout'), {});

export default {
    // comment: { not an entry
    TeamChatSettings: {
        title: "Team chat settings",
        link: "/chat/settings",
        exact: true,
        layout: Layout,
        authenticationRequired: true,
        component: Loadable(loadWithRetry(() => import(/* webpackChunkName: "pages-team-chat-settings" */'../../components/pages/teamChat/ChatSettingsPage'), 'team-chat-settings'), {
            fallback: <Loader />,
        }),
    },
    TeamChat: {
        title: "Team chat",
        link: "/chat",
        links: ["/chat/:channelId"],
        exact: true,
        component: Loadable(() => import('../../components/pages/teamChat/ChatPage'), {}),
    },
    CRMLeads: {
        title: "Leads Management",
        link: "/crm/leads",
        exact: true,
        authenticationRequired: true,
        meta: {
            tag: 'x',
        },
        component: Loadable(() => import(/* webpackChunkName: "pages-crm-leads-index" */'../../components/pages/crm/leads/index'), {
            fallback: <Loader />,
        }),
    },
    CRMLeadDetail: {
        title: "crm:lead_detail",
        link: "/crm/leads/:id",
        component: Loadable(() => import('../../components/pages/crm/leads/detail'), {}),
    },
    OldLeads: {
        title: "Old",
        link: "/leads",
        component: RedirectToCRMLeads,
    },
    NotFound: {
        title: "Not found",
        link: "*",
        component: Loadable(() => import('../../components/pages/error/NotFound'), {}),
    },
    ServiceTickets: {
        title: "service:service_tickets_title",
        link: "/service/tickets",
        component: Loadable(() => import("../../components/pages/service/tickets/index"), {}),
    },
};
`;

const LOGIN = `import Loadable from "../loadablePage";
const AuthPage = Loadable(() =>
    import('../../components/pages/auth/index' /* webpackChunkName: "pages-auth-index" */), {
    fallback: <Loader />
});
const ResetPasswordPage = Loadable(() => import('../../components/pages/auth/resetPassword'), {});

export default {
    Login: {
        title: 'main.auth.login_title',
        link: '/auth/login',
        links: ['/auth/signing', '/auth/signing/', '/auth/signin'],
        exact: true,
        component: AuthPage
    },
    ResetPassword: {
        title: 'main.auth.reset_title',
        link: '/reset-password',
        exact: true,
        component: ResetPasswordPage
    }
}
`;

const POS = `export default {
  Login: {
    title: 'login.title',
    link: '/auth/signin',
    exact: true,
    layout: AuthenticationLayout,
    component: Loadable({
      loader: () => import('../../components/pages/login' /* webpackChunkName: "pages-login-index" */),
      loading: Loader,
      delay: 5500
    })
  },
  Sale: {
    title: 'Sale',
    link: '/sale',
    component: Loadable({ loader: () => import('../../components/pages/sale'), loading: Loader })
  }
};
`;

describe("parsePages", () => {
  const pages = parsePages(ADMIN, "src/config/pages/admin.js");
  const byKey = (k: string) => pages.find((p) => p.key === k)!;

  it("reads link, title, aliases, params, auth and the lazy import of every route", () => {
    expect(pages.map((p) => p.key)).toEqual(["TeamChatSettings", "TeamChat", "CRMLeads", "CRMLeadDetail", "ServiceTickets"]);
    expect(byKey("TeamChatSettings")).toMatchObject({ name: "Team chat settings", link: "/chat/settings", auth: true, params: [], importTarget: "src/components/pages/teamChat/ChatSettingsPage" });
    expect(byKey("TeamChat")).toMatchObject({ link: "/chat", aliases: ["/chat/:channelId"] });
    expect(byKey("CRMLeads")).toMatchObject({ name: "Leads Management", importTarget: "src/components/pages/crm/leads/index", kind: "list", auth: true });
    expect(byKey("CRMLeadDetail")).toMatchObject({ params: ["id"], kind: "other", name: "CRM Lead Detail" });
  });

  it("leaves out redirects and the catch-all route", () => {
    expect(pages.some((p) => p.key === "OldLeads" || p.key === "NotFound")).toBe(false);
  });

  it("uses a readable key when the title is an i18n key", () => {
    expect(byKey("ServiceTickets").name).toBe("Service Tickets");
  });

  it("resolves a component given as a const identifier", () => {
    const login = parsePages(LOGIN, "src/config/pages/login.js");
    expect(login.map((p) => [p.key, p.kind, p.importTarget])).toEqual([
      ["Login", "login", "src/components/pages/auth/index"],
      ["ResetPassword", "login", "src/components/pages/auth/resetPassword"],
    ]);
    expect(login[0].aliases).toEqual(["/auth/signing", "/auth/signing/", "/auth/signin"]);
  });

  it("reads the Loadable({ loader }) form of shop-pos", () => {
    const pos = parsePages(POS, "src/config/pages/login.js");
    expect(pos.map((p) => [p.key, p.link, p.importTarget])).toEqual([
      ["Login", "/auth/signin", "src/components/pages/login"],
      ["Sale", "/sale", "src/components/pages/sale"],
    ]);
    expect(pos[0].kind).toBe("login");
  });

  it("resolves a component that is imported eagerly", () => {
    const src = "import CashRegister from '../../components/pages/cashRegister';\nexport default {\n  RegisterScreen: {\n    title: 'home.title',\n    link: '/sale',\n    component: CashRegister\n  },\n};\n";
    const [p] = parsePages(src, "src/config/pages/kiosk.js");
    expect(p).toMatchObject({ link: "/sale", importTarget: "src/components/pages/cashRegister", kind: "other" });
  });

  it("copes with an empty file and with text that is not a route table", () => {
    expect(parsePages("", "src/config/pages/x.js")).toEqual([]);
    expect(parsePages("const a = { b: 1 };\nmodule.exports = a;\n", "src/config/pages/x.js")).toEqual([]);
  });
});

describe("classify, sort, dedupe, filter", () => {
  it("recognises login and list pages", () => {
    expect(classify("/auth/signin", "Sign in", "admin")).toBe("login");
    expect(classify("/anything", "Anything", "login")).toBe("login");
    expect(classify("/reset-password", "X", "admin")).toBe("login");
    expect(classify("/finance/cash-register", "Cash Register", "admin")).not.toBe("login");
    expect(classify("/crm/leads", "Leads", "admin")).toBe("list");
    expect(classify("/crm/main", "CRM", "admin")).toBe("list");
    expect(classify("/crm/leads/import", "Lead import", "admin")).toBe("other");
    expect(classify("/crm/leads/:id", "Lead", "admin")).toBe("other");
    expect(classify("/settings/store", "Store", "admin")).toBe("other");
  });

  it("puts login first, then lists, dynamic routes last in their kind", () => {
    const all = [
      ...parsePages(ADMIN, "src/config/pages/admin.js"),
      ...parsePages(LOGIN, "src/config/pages/login.js"),
    ];
    expect(sortPages(all).map((p) => p.key)).toEqual(["Login", "ResetPassword", "CRMLeads", "ServiceTickets", "TeamChat", "TeamChatSettings", "CRMLeadDetail"]);
  });

  it("keeps the first table's entry for a repeated path", () => {
    const a = parsePages(ADMIN, "src/config/pages/admin.js");
    const b = parsePages(ADMIN, "src/config/pages/superAdmin.js");
    const merged = dedupeByLink([...a, ...b]);
    expect(merged).toHaveLength(a.length);
    expect(merged.every((p) => p.group === "admin")).toBe(true);
  });

  it("filters by name, path or key", () => {
    const all = parsePages(ADMIN, "src/config/pages/admin.js");
    expect(filterPages(all, "tickets").map((p) => p.key)).toEqual(["ServiceTickets"]);
    expect(filterPages(all, "/crm").map((p) => p.key)).toEqual(["CRMLeads", "CRMLeadDetail"]);
    expect(filterPages(all, "  ")).toHaveLength(all.length);
  });
});

describe("pageForFile", () => {
  const pages = parsePages(ADMIN, "src/config/pages/admin.js");

  it("matches the component file itself, with or without the index suffix", () => {
    expect(pageForFile(pages, "src/components/pages/crm/leads/index.js")).toMatchObject({ exact: true, page: { key: "CRMLeads" } });
    expect(pageForFile(pages, "src/components/pages/teamChat/ChatSettingsPage.jsx")).toMatchObject({ exact: true, page: { key: "TeamChatSettings" } });
  });

  it("maps a file inside the page's folder to that page, the deepest folder first", () => {
    expect(pageForFile(pages, "src/components/pages/crm/leads/LeadsTable.jsx")).toMatchObject({ exact: false, page: { key: "CRMLeads" } });
    expect(pageForFile(pages, "src/components/pages/service/tickets/parts/Row.js")).toMatchObject({ exact: false, page: { key: "ServiceTickets" } });
  });

  it("prefers the list page over a dynamic route in the same folder", () => {
    expect(pageForFile(pages, "src/components/pages/crm/leads/utils.js")?.page.key).toBe("CRMLeads");
    expect(pageForFile(pages, "src/components/pages/crm/leads/detail.js")?.page.key).toBe("CRMLeadDetail");
  });

  it("returns nothing for an unrelated file", () => {
    expect(pageForFile(pages, "src/utils/format.js")).toBeUndefined();
    expect(pageForFile(pages, "README.md")).toBeUndefined();
  });
});

describe("kinds and Expo", () => {
  it("detects the repo kind from marker files", () => {
    expect(detectKind(["metro.config.js", "app.json"], [])).toBe("expo");
    expect(detectKind(["package.json"], ["srcWebServer.js"])).toBe("admin");
    expect(detectKind(["package.json"], ["srcServerTauri.js"])).toBe("pos");
    expect(detectKind(["package.json"], [])).toBe("unknown");
  });

  it("lists Expo screens as entries that open the root", () => {
    const pages = sortPages(expoPages(["LoginScreen.js", "ManagementListScreen.js", "CartScreen.js", "x.test.js", "readme.md"]));
    expect(pages.map((p) => [p.name, p.kind, p.deepLink, p.link])).toEqual([
      ["Login", "login", false, "/"],
      ["Management List", "list", false, "/"],
      ["Cart", "other", false, "/"],
    ]);
    expect(pageForFile(pages, "app/screens/CartScreen.js")).toMatchObject({ exact: true, page: { key: "CartScreen" } });
  });

  it("resolves import specifiers against the table file", () => {
    expect(resolveImport("src/config/pages/admin.js", "../../components/x")).toBe("src/components/x");
    expect(resolveImport("src/config/pages.js", "./pages/login")).toBe("src/config/pages/login");
    expect(resolveImport("src/config/pages/admin.js", "react")).toBeNull();
    expect(resolveImport("a.js", "../../../x")).toBeNull();
  });
});

describe("loadCatalog over the mock files namespace", () => {
  it("reads the route tables of an admin-shaped fixture repo", async () => {
    const { files } = createMockNamespaces();
    await seedPreviewFixture(files, "r", "admin");
    const catalog = await loadCatalog("r", files);
    expect(catalog.kind).toBe("admin");
    expect(catalog.scanned).toEqual(expect.arrayContaining(["src/config/pages/login.js", "src/config/pages/admin.js"]));
    expect(catalog.pages[0]).toMatchObject({ key: "Login", kind: "login" });
    expect(catalog.pages.some((p) => p.link === "/crm/leads" && p.kind === "list")).toBe(true);
    expect(PREVIEW_FIXTURE_FILES.admin["src/config/pages/login.js"]).toContain("/auth/login");
  });

  it("reads Expo screens and finds nothing in a plain repo", async () => {
    const a = createMockNamespaces();
    await seedPreviewFixture(a.files, "r", "expo");
    expect((await loadCatalog("r", a.files)).kind).toBe("expo");
    const plain = createMockNamespaces();
    const c = await loadCatalog("r", plain.files);
    expect(c.pages).toEqual([]);
    expect(c.kind).toBe("unknown");
  });
});
