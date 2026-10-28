import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const HomeIcon = (p: IconProps) => (
  <Base {...p}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></Base>
);
export const BarsIcon = (p: IconProps) => (
  <Base {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Base>
);
export const SearchIcon = (p: IconProps) => (
  <Base {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Base>
);
export const FileIcon = (p: IconProps) => (
  <Base {...p}><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4M9 13h6M9 17h6" /></Base>
);
export const ListIcon = (p: IconProps) => (
  <Base {...p}><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></Base>
);
export const PlugIcon = (p: IconProps) => (
  <Base {...p}><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4" /></Base>
);
export const UsersIcon = (p: IconProps) => (
  <Base {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14a6.5 6.5 0 0 1 3 6" /></Base>
);
export const ClockIcon = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Base>
);
export const RefreshIcon = (p: IconProps) => (
  <Base {...p}><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></Base>
);
export const ExternalIcon = (p: IconProps) => (
  <Base {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></Base>
);
export const PlusIcon = (p: IconProps) => (
  <Base {...p}><path d="M12 5v14M5 12h14" /></Base>
);
export const MenuIcon = (p: IconProps) => (
  <Base {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Base>
);
export const CloseIcon = (p: IconProps) => (
  <Base {...p}><path d="M6 6l12 12M18 6 6 18" /></Base>
);
export const ArrowUpIcon = (p: IconProps) => (
  <Base {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Base>
);
export const ArrowDownIcon = (p: IconProps) => (
  <Base {...p}><path d="M12 5v14M6 13l6 6 6-6" /></Base>
);
export const InfoIcon = (p: IconProps) => (
  <Base {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Base>
);
export const KeyIcon = (p: IconProps) => (
  <Base {...p}><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2 2" /></Base>
);
export const DownloadIcon = (p: IconProps) => (
  <Base {...p}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></Base>
);
