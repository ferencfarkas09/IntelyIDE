import type { FilesIpc } from "../files";
import type { PreviewIpc } from "../preview";
import { validatePreviewUrl } from "../../modules/preview/logic";

export interface MockPreviewOptions {
  /** Decides reachability by port; without it the mock really connects (a no-cors fetch), so a fixture static server works. */
  reachable?: (port: number) => boolean | undefined;
  /** Receives every `openExternal` call (the mock opens nothing). */
  onOpen?: (url: string) => void;
  /** Receives every `proxyStart` call with the upstream port. */
  onProxy?: (upstreamPort: number) => void;
  timeoutMs?: number;
}

export function createMockPreview(opts: MockPreviewOptions = {}): PreviewIpc {
  const check = async (input: string) => {
    const r = validatePreviewUrl(input, globalThis.location?.origin);
    if (!r.ok) throw { code: r.reason, message: r.message };
    return { url: r.url, host: r.host, port: r.port, origin: r.origin };
  };
  return {
    checkUrl: check,
    async probe(url) {
      const t = await check(url);
      const started = Date.now();
      const decided = opts.reachable?.(t.port);
      if (decided !== undefined) return { reachable: decided, port: t.port, ms: 0 };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 800);
      try {
        await fetch(t.origin + "/", { mode: "no-cors", cache: "no-store", signal: ctl.signal });
        return { reachable: true, port: t.port, ms: Date.now() - started };
      } catch {
        return { reachable: false, port: t.port, ms: Date.now() - started };
      } finally {
        clearTimeout(timer);
      }
    },
    async openExternal(url) {
      const t = await check(url);
      opts.onOpen?.(t.url);
    },
    // The mock has no Rust proxy: the "proxy" is the dev server's own origin (no injected script, so click-to-source stays idle).
    async proxyStart(url) {
      const t = await check(url);
      opts.onProxy?.(t.port);
      return { url: `${t.origin}/`, port: t.port, upstreamPort: t.port };
    },
    async proxyStop() {},
  };
}

// --- fixture repos for the quick-list ----------------------------------------------------------------------------

const ADMIN_LOGIN = `import Loadable from "../loadablePage";
const AuthPage = Loadable(() => import('../../components/pages/auth/index'), {});
const ResetPasswordPage = Loadable(() => import('../../components/pages/auth/resetPassword'), {});

export default {
    Login: {
        title: 'main.auth.login_title',
        link: '/auth/login',
        links: ['/auth/signin'],
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

const page = (key: string, title: string, link: string, target: string, auth = true) =>
  `    ${key}: {\n        title: "${title}",\n        link: "${link}",\n        exact: true,\n        authenticationRequired: ${auth},\n        component: Loadable(() => import('../../components/pages/${target}'), {}),\n    },\n`;

const ADMIN_PAGES =
  `import Loadable from "../loadablePage";\nconst RedirectToLeads = () => <Redirect to="/crm/leads" />;\n\nexport default {\n` +
  page("CRMLeads", "Leads Management", "/crm/leads", "crm/leads/index") +
  page("CRMLeadDetail", "Lead", "/crm/leads/:id", "crm/leads/detail") +
  page("ServiceTickets", "Service Tickets", "/service/tickets", "service/tickets/index") +
  page("Orders", "Orders", "/orders/main", "orders/index") +
  page("Partners", "Partners", "/partners/main", "partners/index") +
  page("Employees", "Employees", "/settings/employees", "settings/employees/index") +
  page("StoreSettings", "Store settings", "/settings/store", "settings/store/index") +
  `    Old: {\n        title: "Old",\n        link: "/leads",\n        component: RedirectToLeads,\n    },\n};\n`;

const POS_LOGIN = `export default {
  Login: {
    title: 'login.title',
    link: '/auth/signin',
    exact: true,
    component: Loadable({
      loader: () => import('../../components/pages/login'),
      loading: Loader
    })
  }
};
`;

const POS_KIOSK = `export default {
  Sale: {
    title: 'Sale',
    link: '/sale',
    exact: true,
    component: Loadable({ loader: () => import('../../components/pages/sale'), loading: Loader })
  },
  Tables: {
    title: 'Tables',
    link: '/kiosk/tables',
    exact: true,
    component: Loadable({ loader: () => import('../../components/pages/tables'), loading: Loader })
  }
};
`;

/** Repo-relative path -> text of a tiny repo per kind: marker files plus the route tables the quick-list scans. */
export const PREVIEW_FIXTURE_FILES: Record<"admin" | "pos" | "expo", Record<string, string>> = {
  admin: {
    "tools/srcWebServer.js": "// fixture\n",
    "src/config/pages/login.js": ADMIN_LOGIN,
    "src/config/pages/admin.js": ADMIN_PAGES,
    "src/components/pages/crm/leads/index.js": "export default function Leads() { return null; }\n",
    "src/components/pages/crm/leads/LeadsTable.js": "export const LeadsTable = () => null;\n",
  },
  pos: {
    "tools/srcServerTauri.js": "// fixture\n",
    "src/config/pages/login.js": POS_LOGIN,
    "src/config/pages/kiosk.js": POS_KIOSK,
  },
  expo: {
    "metro.config.js": "// fixture\n",
    "app/screens/LoginScreen.js": "export default function LoginScreen() { return null; }\n",
    "app/screens/ManagementListScreen.js": "export default function ManagementListScreen() { return null; }\n",
    "app/screens/CartScreen.js": "export default function CartScreen() { return null; }\n",
    "app/screens/HomeScreen.js": "export default function HomeScreen() { return null; }\n",
  },
};

/** Writes a fixture repo's files through the (mock) files namespace so the catalog scan has something to read. */
export async function seedPreviewFixture(files: FilesIpc, repoId: string, kind: keyof typeof PREVIEW_FIXTURE_FILES): Promise<void> {
  for (const [path, text] of Object.entries(PREVIEW_FIXTURE_FILES[kind])) {
    // Seeding twice is fine: an existing file is overwritten with the current mtime.
    const mtime = await files.readFile(repoId, path).then((r) => r.mtimeMs, () => 0);
    await files.writeFile(repoId, path, text, mtime);
  }
}
