import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import useStore, { MODULE_GROUPS, MODULE_CONFIG, getGroupModuleIds, getModuleName } from '../store.js';
import {
  Sidebar,
  useSidebar
} from '@cloudflare/kumo/components/sidebar';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { Button } from '@cloudflare/kumo/components/button';
import { Tabs } from '@cloudflare/kumo';
import { TOOL_TABS_PROPS } from '../modules/kumoTabs.js';
import AppPageHeader, { AppBreadcrumbs } from './AppPageHeader.jsx';
import {
  Globe,
  Server,
  LogOut,
  AppWindow,
  Columns,
  DesktopDisplay,
  Maximize2,
  Palette,
  Rectangle,
  Sun,
  Moon,
  getModuleIconComponent,
} from './Icons.jsx';

const DashboardPage = lazy(() => import('../pages/DashboardPage.jsx'));
const ServerPage = lazy(() => import('../pages/ServerPage.jsx'));
const TotpPage = lazy(() => import('../pages/TotpPage.jsx'));
const FileboxPage = lazy(() => import('../pages/FileboxPage.jsx'));
const UptimePage = lazy(() => import('../pages/UptimePage.jsx'));
const NotificationPage = lazy(() => import('../pages/NotificationPage.jsx'));
const OpenAIPage = lazy(() => import('../pages/OpenAIPage.jsx'));
const SubscriptionPage = lazy(() => import('../pages/SubscriptionPage.jsx'));


const PaasPage = lazy(() => import('../pages/PaasPage.jsx'));
const DnsPage = lazy(() => import('../pages/DnsPage.jsx'));
const AliyunPage = lazy(() => import('../pages/AliyunPage.jsx'));
const TencentPage = lazy(() => import('../pages/TencentPage.jsx'));
const OraclePage = lazy(() => import('../pages/OraclePage.jsx'));
const M365Page = lazy(() => import('../pages/M365Page.jsx'));
const SettingsPage = lazy(() => import('../pages/SettingsPage.jsx'));
const SchedulerPage = lazy(() => import('../pages/SchedulerPage.jsx'));
const ApiDocsPage = lazy(() => import('../pages/ApiDocsPage.jsx'));
const SystemLogsPage = lazy(() => import('../pages/SystemLogsPage.jsx'));

const PageLoadingFallback = () => (
  <div className="flex min-h-[240px] items-center justify-center">
    <div
      className="h-8 w-8 animate-spin rounded-full border-2 border-kumo-line border-t-kumo-brand"
      aria-label="Loading"
      role="status"
    />
  </div>
);

class ModuleErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('module render failed:', error, info);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.moduleId !== this.props.moduleId && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <div className="app-card w-full max-w-xl p-5">
          <div className="mb-2 text-sm font-bold text-kumo-strong">模块加载失败</div>
          <div className="mb-4 text-xs leading-relaxed text-kumo-subtle">
            前端资源可能已更新或缓存仍指向旧文件。请重新加载当前页面后再试。
          </div>
          <div className="mb-4 rounded-md border border-kumo-line bg-kumo-recessed/50 p-3 font-mono text-[11px] leading-relaxed text-kumo-subtle">
            {this.state.error?.message || '未知错误'}
          </div>
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={() => {
              const url = new URL(window.location.href);
              url.searchParams.set('_reload', String(Date.now()));
              window.location.replace(url.toString());
            }}
            className="font-bold"
          >
            重新加载
          </Button>
        </div>
      </div>
    );
  }
}

const MODULE_PATHS = Object.keys(MODULE_CONFIG).reduce((paths, moduleId) => {
  paths[moduleId] = `/${moduleId}`;
  return paths;
}, { dashboard: '/dashboard' });

const LEGACY_MODULE_PATHS = {
  'self-h': 'scheduler',
};

const getPathModule = (pathname) => {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mockDocker')) {
    return 'server';
  }
  if (normalized === '/') return 'dashboard';
  const route = normalized.slice(1);
  if (LEGACY_MODULE_PATHS[route]) return LEGACY_MODULE_PATHS[route];
  return MODULE_CONFIG[route] ? route : null;
};

const PAGE_WIDTH_CLASSES = {
  standard: 'max-w-7xl',
  wide: 'max-w-[1600px]',
  full: 'max-w-none',
};

const renderSidebarStyleIcon = (IconComponent, label) => (
  <span
    title={label}
    aria-label={label}
    className="inline-flex h-4 w-4 items-center justify-center"
  >
    <IconComponent className="h-3.5 w-3.5" />
  </span>
);

const PAGE_WIDTH_OPTIONS = [
  { value: 'standard', label: renderSidebarStyleIcon(Rectangle, '标准宽度'), className: 'w-full !justify-center !px-0' },
  { value: 'wide', label: renderSidebarStyleIcon(Columns, '宽屏宽度'), className: 'w-full !justify-center !px-0' },
  { value: 'full', label: renderSidebarStyleIcon(Maximize2, '全宽'), className: 'w-full !justify-center !px-0' },
];

const THEME_MODE_OPTIONS = [
  { value: 'auto', label: renderSidebarStyleIcon(DesktopDisplay, '自动跟随系统'), className: 'w-full !justify-center !px-0' },
  { value: 'light', label: renderSidebarStyleIcon(Sun, '浅色模式'), className: 'w-full !justify-center !px-0' },
  { value: 'dark', label: renderSidebarStyleIcon(Moon, '深色模式'), className: 'w-full !justify-center !px-0' },
];

const useMobileClosingNavigation = (onNavigate) => {
  const { isMobile, setOpenMobile } = useSidebar();

  return (module) => {
    onNavigate(module);
    if (isMobile) setOpenMobile(false);
  };
};

const SidebarTooltipMenuButton = ({ label, children, ...props }) => {
  const { isMobile, state } = useSidebar();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const allowTooltip = !isMobile && state === 'collapsed';

  useEffect(() => {
    if (!allowTooltip) setTooltipOpen(false);
  }, [allowTooltip]);

  return (
    <Sidebar.MenuItem>
      <Tooltip
        content={label}
        side="right"
        open={allowTooltip ? tooltipOpen : false}
        onOpenChange={(open) => setTooltipOpen(allowTooltip && open)}
        render={(
          <Sidebar.MenuButton {...props} aria-label={label}>
            {children}
          </Sidebar.MenuButton>
        )}
      />
    </Sidebar.MenuItem>
  );
};

const SidebarModuleButton = ({ module, active, icon: IconComponent, onNavigate }) => {
  const navigateAndClose = useMobileClosingNavigation(onNavigate);
  const config = MODULE_CONFIG[module];
  if (!config) return null;

  return (
    <SidebarTooltipMenuButton
      label={config.name}
      active={active}
      aria-current={active ? 'page' : undefined}
      onClick={() => navigateAndClose(module)}
      icon={IconComponent}
    >
      {config.name}
    </SidebarTooltipMenuButton>
  );
};

const SidebarModuleSubButton = ({ module, active, onNavigate }) => {
  const navigateAndClose = useMobileClosingNavigation(onNavigate);
  const config = MODULE_CONFIG[module];
  if (!config) return null;

  return (
    <Sidebar.MenuSubButton
      active={active}
      aria-current={active ? 'page' : undefined}
      onClick={() => navigateAndClose(module)}
    >
      {config.name}
    </Sidebar.MenuSubButton>
  );
};

const SidebarModuleSubgroup = ({ subgroup, activeModule, onNavigate }) => {
  const subgroupModules = subgroup.modules || [];
  const active = subgroupModules.includes(activeModule);
  const ParentIcon = subgroup.icon || Globe;
  const quietTriggerClassName = [
    '!bg-transparent',
    '!shadow-none',
    '!text-inherit',
    'active:!bg-transparent',
    'hover:!bg-transparent',
    'hover:!text-inherit',
    'focus-visible:!bg-transparent',
    'focus-visible:!shadow-none',
    'data-[active=true]:!bg-transparent',
    'data-[selected=true]:!bg-transparent',
    'data-[state=open]:!bg-transparent',
    'data-[state=open]:!text-inherit',
    '[&_[data-slot=sidebar-menu-button-label]]:!font-normal',
  ].join(' ');

  return (
    <Sidebar.MenuItem>
      <Sidebar.Collapsible key={`${subgroup.id}-${active ? 'active' : 'idle'}`} defaultOpen={active} autoScrollOnOpen>
        <Sidebar.CollapsibleTrigger
          render={(
            <Sidebar.MenuButton icon={ParentIcon} className={quietTriggerClassName}>
              {subgroup.name}
              <Sidebar.MenuChevron />
            </Sidebar.MenuButton>
          )}
        />
        <Sidebar.CollapsibleContent>
          <Sidebar.MenuSub>
            {subgroupModules.map((module) => (
              <SidebarModuleSubButton
                key={module}
                module={module}
                active={activeModule === module}
                onNavigate={onNavigate}
              />
            ))}
          </Sidebar.MenuSub>
        </Sidebar.CollapsibleContent>
      </Sidebar.Collapsible>
    </Sidebar.MenuItem>
  );
};

const SidebarLogoutButton = ({ onLogout }) => {
  return (
    <SidebarTooltipMenuButton
      label="安全退出"
      onClick={onLogout}
      className="text-kumo-danger hover:bg-kumo-danger/10"
      icon={LogOut}
    >
      安全退出
    </SidebarTooltipMenuButton>
  );
};

const SidebarBrand = ({ onHome }) => (
  <button
    type="button"
    onClick={onHome}
    className="flex h-full w-full min-w-0 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand/45"
    aria-label="返回首页"
  >
    <span className="flex size-9 shrink-0 items-center justify-center">
      <img src="/logo.svg" className="size-6.5 shrink-0 object-contain" alt="" />
    </span>
    <span className="min-w-0 truncate text-sm font-semibold text-kumo-strong">
      API Monitor
    </span>
  </button>
);

const SidebarStyleSwitches = ({
  pageWidthMode,
  onPageWidthChange,
  themeMode,
  onThemeModeChange,
}) => {
  const controlRowClassName = [
    'group/menu-button relative flex w-full min-w-0 items-center gap-2.5 rounded-lg text-kumo-default',
    'before:absolute before:inset-x-0 before:-inset-y-px',
    'min-h-8.5 px-3 py-0 text-sm transition-[color,box-shadow,outline] duration-(--sidebar-animation-duration)',
    'hover:bg-transparent',
    'active:bg-transparent',
    'focus-within:bg-transparent',
  ].join(' ');
  const controlRowInnerClassName = [
    'flex flex-1 min-w-0 items-center gap-3',
    'translate-x-[-3px] group-not-data-[state=collapsed]/sidebar:translate-x-0',
    'transition-transform duration-(--sidebar-animation-duration)',
  ].join(' ');

  return (
    <Sidebar.Group className="mt-auto">
      <Sidebar.GroupLabel>样式切换</Sidebar.GroupLabel>
      <Sidebar.Menu>
        <Sidebar.MenuItem>
          <div className={controlRowClassName} data-sidebar="menu-button">
            <div className={controlRowInnerClassName}>
              <span
                className="h-4 w-4 shrink-0 opacity-40"
                title="页面宽度"
                aria-label="页面宽度"
              >
                <AppWindow className="h-4 w-4" />
              </span>
              <div className="sidebar-style-tabs min-w-0 flex-1 group-data-[state=collapsed]/sidebar:hidden">
                <Tabs
                  {...TOOL_TABS_PROPS}
                  className="w-full min-w-0"
                  listClassName="grid w-full grid-cols-3"
                  value={pageWidthMode}
                  onValueChange={onPageWidthChange}
                  tabs={PAGE_WIDTH_OPTIONS}
                />
              </div>
            </div>
          </div>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <div className={controlRowClassName} data-sidebar="menu-button">
            <div className={controlRowInnerClassName}>
              <span
                className="h-4 w-4 shrink-0 opacity-40"
                title="主题模式"
                aria-label="主题模式"
              >
                <Palette className="h-4 w-4" />
              </span>
              <div className="sidebar-style-tabs min-w-0 flex-1 group-data-[state=collapsed]/sidebar:hidden">
                <Tabs
                  {...TOOL_TABS_PROPS}
                  className="w-full min-w-0"
                  listClassName="grid w-full grid-cols-3"
                  value={themeMode}
                  onValueChange={onThemeModeChange}
                  tabs={THEME_MODE_OPTIONS}
                />
              </div>
            </div>
          </div>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.Group>
  );
};

function MainLayout() {
  const {
    mainActiveTab,
    setMainActiveTab,
    sidebarCollapsed,
    setSidebarCollapsed,
    themeMode,
    setThemeMode,
    pageWidthMode,
    setPageWidthMode,
    moduleVisibility,
    moduleOrder,
    userSettingsLoaded,
    loadUserSettings,
    logout,
  } = useStore();
  const pageWidthClass = PAGE_WIDTH_CLASSES[pageWidthMode] || PAGE_WIDTH_CLASSES.standard;

  const visibleModuleGroups = useMemo(() => {
    return MODULE_GROUPS.map((group) => {
      const directModules = moduleOrder.filter(
        (moduleId) => (group.modules || []).includes(moduleId) && moduleVisibility[moduleId] !== false
      );
      const subgroups = (group.subgroups || []).map((subgroup) => ({
        ...subgroup,
        modules: moduleOrder.filter(
          (moduleId) => (subgroup.modules || []).includes(moduleId) && moduleVisibility[moduleId] !== false
        ),
      })).filter((subgroup) => subgroup.modules.length > 0);
      const trailingModules = moduleOrder.filter(
        (moduleId) => (group.trailingModules || []).includes(moduleId) && moduleVisibility[moduleId] !== false
      );

      return {
        ...group,
        modules: directModules,
        subgroups,
        trailingModules,
      };
    }).filter((group) => {
      if (group.id === 'system') return false;
      return getGroupModuleIds(group).some((moduleId) => moduleVisibility[moduleId] !== false);
    });
  }, [moduleOrder, moduleVisibility]);

  useEffect(() => {
    if (!userSettingsLoaded) {
      loadUserSettings();
    }
  }, [loadUserSettings, userSettingsLoaded]);

  useEffect(() => {
    const syncTabFromLocation = () => {
      const routeTab = getPathModule(window.location.pathname);
      if (!routeTab) return;
      const currentTab = useStore.getState().mainActiveTab;
      if (currentTab !== routeTab) {
        useStore.getState().setMainActiveTab(routeTab);
      }
      if (routeTab === 'server' && new URLSearchParams(window.location.search).has('mockDocker') && window.location.pathname !== '/server') {
        window.history.replaceState({ module: 'server' }, '', `/server${window.location.search}`);
      }
    };

    syncTabFromLocation();
    window.addEventListener('popstate', syncTabFromLocation);
    return () => window.removeEventListener('popstate', syncTabFromLocation);
  }, []);

  useEffect(() => {
    const legacyModule = window.location.pathname.replace(/\/+$/, '').slice(1);
    const currentModule = LEGACY_MODULE_PATHS[legacyModule];
    if (!currentModule) return;
    const nextPath = MODULE_PATHS[currentModule] || `/${currentModule}`;
    window.history.replaceState({ module: currentModule }, '', nextPath);
  }, []);

  const navigateToModule = (module) => {
    setMainActiveTab(module);
    const nextPath = MODULE_PATHS[module] || `/${module}`;
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ module }, '', nextPath);
    }
  };

  const navigateHome = () => {
    setMainActiveTab('dashboard');
    if (window.location.pathname !== '/' || window.location.search || window.location.hash) {
      window.history.pushState({ module: 'dashboard' }, '', '/');
    }
  };

  useEffect(() => {
    if (!userSettingsLoaded || mainActiveTab === 'settings') return;
    if (moduleVisibility[mainActiveTab] !== false) return;

    const nextModule = moduleOrder.find((moduleId) => moduleVisibility[moduleId] !== false) || 'dashboard';
    setMainActiveTab(nextModule);
    const nextPath = MODULE_PATHS[nextModule] || `/${nextModule}`;
    if (window.location.pathname !== nextPath) {
      window.history.replaceState({ module: nextModule }, '', nextPath);
    }
  }, [mainActiveTab, moduleOrder, moduleVisibility, setMainActiveTab, userSettingsLoaded]);

  const viewportWorkspaceModule = ['apidocs', 'systemlogs', 'settings', 'dns'].includes(mainActiveTab);
  const mainCanvasClassName = viewportWorkspaceModule
    ? 'flex-1 overflow-hidden p-3 sm:p-4 lg:px-8 lg:pb-6 lg:pt-3'
    : 'flex-1 overflow-x-hidden overflow-y-auto p-3 sm:p-4 lg:px-8 lg:pb-6 lg:pt-3 scrollbar-thin';
  const mainCanvasInnerClassName = `mx-auto flex w-full min-w-0 flex-col ${viewportWorkspaceModule ? 'h-full min-h-0' : 'min-h-full'} ${pageWidthClass}`;

  // 渲染当前模块页
  const renderActivePage = () => {
    switch (mainActiveTab) {
      case 'dashboard':
        return <DashboardPage onNavigate={navigateToModule} />;
      case 'openai':
        return <OpenAIPage />;
      case 'subscription':
        return <SubscriptionPage />;


      case 'paas':
        return <PaasPage />;
      case 'dns':
        return <DnsPage />;
      case 'aliyun':
        return <AliyunPage />;
      case 'tencent':
        return <TencentPage />;
      case 'oracle':
        return <OraclePage />;
      case 'm365':
        return <M365Page />;
      case 'server':
        return <ServerPage />;
      case 'totp':
        return <TotpPage />;
      case 'filebox':
        return <FileboxPage />;
      case 'uptime':
        return <UptimePage />;
      case 'notification':
        return <NotificationPage />;
      case 'settings':
        return <SettingsPage />;
      case 'scheduler':
        return <SchedulerPage />;
      case 'apidocs':
        return <ApiDocsPage />;
      case 'systemlogs':
        return <SystemLogsPage />;
      default:
        const ActiveIcon = getModuleIconComponent(mainActiveTab, Server);
        return (
          <div className="flex flex-col items-center justify-center h-[60vh] text-center p-6 app-card max-w-xl mx-auto">
            <div className="w-16 h-16 rounded-full app-subcard bg-kumo-recessed flex items-center justify-center mb-5 text-kumo-brand">
              <ActiveIcon className="w-7 h-7" />
            </div>
            <h2 className="text-base font-bold text-kumo-strong mb-2.5">
              {getModuleName(mainActiveTab)} 模块重构中
            </h2>
            <p className="text-xs text-kumo-subtle max-w-sm leading-relaxed">
              我们正在使用 React + Kumo + Tailwind v4 像素级重构该页面，在此期间原有逻辑将暂时不可用。
            </p>
          </div>
        );
    }
  };

  return (
    <Sidebar.Provider
      defaultOpen={!sidebarCollapsed}
      open={!sidebarCollapsed}
      onOpenChange={(open) => setSidebarCollapsed(!open)}
      peekable
      style={{
        '--sidebar-width': '12.5rem',
        '--sidebar-width-icon': '54px',
      }}
      className="app-main-shell flex h-screen w-screen overflow-hidden text-kumo-default"
    >
      <>
        {/* ==================== 1. 侧边栏 (Sidebar) ==================== */}
        <Sidebar>
          {/* 顶部 Logo */}
          <Sidebar.Header className="h-14! px-2.5!">
            <SidebarBrand onHome={navigateHome} />
          </Sidebar.Header>

          {/* 导航栏项 */}
          <Sidebar.Content>
            {visibleModuleGroups.map((group) => {
              const groupLabel = group.id === 'overview' ? '总览' : group.name;

              return (
                <Sidebar.Group key={group.id}>
                  <Sidebar.GroupLabel>{groupLabel}</Sidebar.GroupLabel>
                  <Sidebar.Menu>
                    {group.modules.map((module) => (
                      <SidebarModuleButton
                        key={module}
                        module={module}
                        active={mainActiveTab === module}
                        icon={getModuleIconComponent(module, Server)}
                        onNavigate={navigateToModule}
                      />
                    ))}
                    {(group.subgroups || []).map((subgroup) => (
                      <SidebarModuleSubgroup
                        key={subgroup.id}
                        subgroup={subgroup}
                        activeModule={mainActiveTab}
                        onNavigate={navigateToModule}
                      />
                    ))}
                    {(group.trailingModules || []).map((module) => (
                      <SidebarModuleButton
                        key={module}
                        module={module}
                        active={mainActiveTab === module}
                        icon={getModuleIconComponent(module, Server)}
                        onNavigate={navigateToModule}
                      />
                    ))}
                  </Sidebar.Menu>
                </Sidebar.Group>
              );
            })}
            <Sidebar.Group>
              <Sidebar.GroupLabel>系统</Sidebar.GroupLabel>
              <Sidebar.Menu>
                {moduleOrder.includes('apidocs') && moduleVisibility.apidocs !== false && (
                  <SidebarModuleButton
                    module="apidocs"
                    active={mainActiveTab === 'apidocs'}
                    icon={getModuleIconComponent('apidocs', Server)}
                    onNavigate={navigateToModule}
                  />
                )}

                {moduleOrder.includes('systemlogs') && moduleVisibility.systemlogs !== false && (
                  <SidebarModuleButton
                    module="systemlogs"
                    active={mainActiveTab === 'systemlogs'}
                    icon={getModuleIconComponent('systemlogs', Server)}
                    onNavigate={navigateToModule}
                  />
                )}

                <SidebarModuleButton
                  module="settings"
                  active={mainActiveTab === 'settings'}
                  icon={getModuleIconComponent('settings', Server)}
                  onNavigate={navigateToModule}
                />

                <SidebarLogoutButton onLogout={logout} />
              </Sidebar.Menu>
            </Sidebar.Group>
            <SidebarStyleSwitches
              pageWidthMode={pageWidthMode}
              onPageWidthChange={setPageWidthMode}
              themeMode={themeMode}
              onThemeModeChange={setThemeMode}
            />
          </Sidebar.Content>

          {/* 底部功能栏 */}
          <Sidebar.Footer className="px-[11px]!">
            <Sidebar.Trigger />
          </Sidebar.Footer>
        </Sidebar>

        {/* ==================== 2. 主页面区 (Main Panel) ==================== */}
        <div className="flex-1 flex flex-col h-full overflow-hidden">
          {/* 顶部导航 */}
          <header className="app-main-topbar flex h-14 flex-shrink-0 items-center border-b border-kumo-line px-3 min-[450px]:px-4 md:px-6">
            <div className="flex h-full min-w-0 flex-1 items-center gap-3.5">
              <Sidebar.Trigger className="md:hidden" />

              <AppPageHeader
                className="flex-row items-center justify-between"
                spacing="compact"
                breadcrumbs={(
                  <AppBreadcrumbs size="sm" className="mr-0 min-w-0 overflow-hidden">
                    <AppBreadcrumbs.Link href={MODULE_PATHS.dashboard}>首页</AppBreadcrumbs.Link>
                    <AppBreadcrumbs.Separator />
                    <AppBreadcrumbs.Current>{getModuleName(mainActiveTab)}</AppBreadcrumbs.Current>
                  </AppBreadcrumbs>
                )}
              >
                {/* <div className="flex h-6.5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-kumo-success/20 bg-kumo-success/10 px-2 text-[11px] text-kumo-success">
                  <span className="w-1 h-1 rounded-full bg-current animate-pulse"></span>
                  <span className="hidden min-[520px]:inline">健康</span>
                  <span className="min-[520px]:hidden">正常</span>
                </div> */}
              </AppPageHeader>
            </div>
          </header>

          {/* 主内容画布 */}
          <main className={mainCanvasClassName}>
            <div className={mainCanvasInnerClassName}>
              <ModuleErrorBoundary moduleId={mainActiveTab}>
                <Suspense fallback={<PageLoadingFallback />}>
                  {renderActivePage()}
                </Suspense>
              </ModuleErrorBoundary>
            </div>
          </main>
        </div>
      </>
    </Sidebar.Provider>
  );
}

export default MainLayout;
