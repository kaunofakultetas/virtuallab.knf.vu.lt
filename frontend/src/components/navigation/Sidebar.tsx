import { useState } from "react";
import { NavLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import DashboardOutlinedIcon from "@mui/icons-material/DashboardOutlined";
import ComputerOutlinedIcon from "@mui/icons-material/ComputerOutlined";
import PeopleOutlinedIcon from "@mui/icons-material/PeopleOutlined";
import LogoutOutlinedIcon from "@mui/icons-material/LogoutOutlined";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import AdminPanelSettingsOutlinedIcon from "@mui/icons-material/AdminPanelSettingsOutlined";
import ViewModuleOutlinedIcon from "@mui/icons-material/ViewModuleOutlined";
import DesktopWindowsOutlinedIcon from "@mui/icons-material/DesktopWindowsOutlined";
import MonitorHeartOutlinedIcon from "@mui/icons-material/MonitorHeartOutlined";
import TuneOutlinedIcon from "@mui/icons-material/TuneOutlined";
import { useAuth } from "@/utils/AuthGuard";

const SIDEBAR_W = 220;
const SIDEBAR_W_COLLAPSED = 64;
const ACTIVE_COLOR = "#78003F";

interface NavItem {
    label: string;
    icon: React.ReactNode;
    path: string;
}

interface NavSection {
    section: string;
    adminOnly?: boolean;
    items: NavItem[];
}

const NAV: NavSection[] = [
    {
        section: "Main",
        items: [
            {
                label: "Dashboard",
                icon: <DashboardOutlinedIcon fontSize="small" />,
                path: "/",
            },
        ],
    },
    {
        section: "Instances",
        items: [
            {
                label: "My Instances",
                icon: <ComputerOutlinedIcon fontSize="small" />,
                path: "/instances",
            },
        ],
    },
    {
        section: "Admin",
        adminOnly: true,
        items: [
            {
                label: "Users",
                icon: <PeopleOutlinedIcon fontSize="small" />,
                path: "/admin/users",
            },
            {
                label: "Instances",
                icon: <AdminPanelSettingsOutlinedIcon fontSize="small" />,
                path: "/admin/instances",
            },
            {
                label: "Templates",
                icon: <ViewModuleOutlinedIcon fontSize="small" />,
                path: "/admin/templates",
            },
            {
                label: "Guacamole",
                icon: <DesktopWindowsOutlinedIcon fontSize="small" />,
                path: "/admin/guacamole",
            },
            {
                label: "Proxmox Dashboard",
                icon: <MonitorHeartOutlinedIcon fontSize="small" />,
                path: "/admin/proxmox-dashboard",
            },
            {
                label: "Settings",
                icon: <TuneOutlinedIcon fontSize="small" />,
                path: "/admin/settings",
            },
        ],
    },
];

function SidebarItem({
    item,
    collapsed,
}: {
    item: NavItem;
    collapsed: boolean;
}) {
    return (
        <Tooltip title={collapsed ? item.label : ""} placement="right" arrow>
            <NavLink
                to={item.path}
                end={item.path === "/"}
                style={{ textDecoration: "none" }}
            >
                {({ isActive }) => (
                    <Box
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 1.5,
                            px: collapsed ? 0 : 2,
                            py: 0.9,
                            mx: 1,
                            borderRadius: 2,
                            cursor: "pointer",
                            justifyContent: collapsed ? "center" : "flex-start",
                            bgcolor: isActive ? ACTIVE_COLOR : "transparent",
                            "& svg": {
                                color: isActive ? "#fff" : "text.secondary",
                            },
                            "&:hover": {
                                bgcolor: isActive
                                    ? ACTIVE_COLOR
                                    : "action.hover",
                            },
                            transition: "background 150ms ease",
                        }}
                    >
                        {item.icon}
                        {!collapsed && (
                            <Typography
                                variant="body2"
                                fontWeight={isActive ? 600 : 400}
                                noWrap
                                sx={{
                                    color: isActive ? "#fff" : "text.primary",
                                }}
                            >
                                {item.label}
                            </Typography>
                        )}
                    </Box>
                )}
            </NavLink>
        </Tooltip>
    );
}

interface SidebarProps {
    onLogout: () => void;
}

export function Sidebar({ onLogout }: SidebarProps) {
    const [collapsed, setCollapsed] = useState(false);
    const auth = useAuth();

    const visibleSections = NAV.filter(
        (s) => !s.adminOnly || auth?.role === "admin",
    );

    return (
        <Box
            component="nav"
            sx={{
                width: collapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W,
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                bgcolor: "background.paper",
                borderRight: 1,
                borderColor: "divider",
                transition: "width 200ms ease",
                overflow: "hidden",
            }}
        >
            <Box
                sx={{
                    display: "flex",
                    justifyContent: collapsed ? "center" : "flex-end",
                    p: 0.75,
                }}
            >
                <IconButton
                    size="small"
                    onClick={() => setCollapsed((c) => !c)}
                >
                    {collapsed ? (
                        <ChevronRightIcon fontSize="small" />
                    ) : (
                        <ChevronLeftIcon fontSize="small" />
                    )}
                </IconButton>
            </Box>

            <Divider />

            <Box
                sx={{ flex: 1, overflowY: "auto", overflowX: "hidden", py: 1 }}
            >
                {visibleSections.map((section) => (
                    <Box key={section.section} sx={{ mb: 1.5 }}>
                        {!collapsed && (
                            <Typography
                                variant="caption"
                                sx={{
                                    px: 2,
                                    pb: 0.25,
                                    display: "block",
                                    color: "text.disabled",
                                    fontWeight: 700,
                                    letterSpacing: "0.08em",
                                    textTransform: "uppercase",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {section.section}
                            </Typography>
                        )}
                        {section.items.map((item) => (
                            <SidebarItem
                                key={item.path}
                                item={item}
                                collapsed={collapsed}
                            />
                        ))}
                    </Box>
                ))}
            </Box>

            <Divider />

            <Tooltip title={collapsed ? "Logout" : ""} placement="right" arrow>
                <Box
                    onClick={onLogout}
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1.5,
                        px: collapsed ? 0 : 2,
                        py: 1.25,
                        mx: 1,
                        my: 0.75,
                        borderRadius: 2,
                        cursor: "pointer",
                        justifyContent: collapsed ? "center" : "flex-start",
                        "&:hover": {
                            bgcolor: "action.hover",
                            "& svg, & p": { color: "error.main" },
                        },
                        transition: "background 150ms ease",
                    }}
                >
                    <LogoutOutlinedIcon
                        fontSize="small"
                        sx={{ color: "text.secondary" }}
                    />
                    {!collapsed && (
                        <Typography
                            variant="body2"
                            sx={{ color: "text.secondary" }}
                            noWrap
                        >
                            Logout
                        </Typography>
                    )}
                </Box>
            </Tooltip>
        </Box>
    );
}
