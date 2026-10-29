import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "brand"
  | "chat"
  | "folder"
  | "plus"
  | "search"
  | "calculator"
  | "spark"
  | "chevron"
  | "paperclip"
  | "send"
  | "more"
  | "menu"
  | "check"
  | "alert"
  | "loader"
  | "terminal";

const drawings: Record<IconName, ReactNode> = {
  brand: (
    <>
      <path d="M5 7.5 12 3l7 4.5v9L12 21l-7-4.5z" />
      <path d="m8.5 10 3.5-2.2 3.5 2.2M8.5 14l3.5 2.2 3.5-2.2" />
    </>
  ),
  chat: <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l1.8-3.1A7.5 7.5 0 1 1 20 11.5Z" />,
  folder: <path d="M3.5 6.5h6l2 2H20a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 20 18.5H4A1.5 1.5 0 0 1 2.5 17V8A1.5 1.5 0 0 1 4 6.5Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m15.5 15.5 4 4" /></>,
  calculator: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8.5 7h7M8.5 12h1m3 0h1m3 0h.01m-8.01 4h1m3 0h1m3 0h.01" /></>,
  spark: <><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" /></>,
  chevron: <path d="m7 10 5 5 5-5" />,
  paperclip: <path d="m8 12.5 6.4-6.4a3 3 0 0 1 4.2 4.2l-8.1 8.1a4.5 4.5 0 0 1-6.4-6.4l8-8" />,
  send: <><path d="m21 3-7.2 18-3.6-7.2L3 10.2 21 3Z" /><path d="M10.2 13.8 15 9" /></>,
  more: <><circle cx="5" cy="12" r=".8" /><circle cx="12" cy="12" r=".8" /><circle cx="19" cy="12" r=".8" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: <><path d="M12 3 2.8 19h18.4L12 3Z" /><path d="M12 9v4m0 3h.01" /></>,
  loader: <><path d="M20.2 12a8.2 8.2 0 1 1-2.4-5.8" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
};

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {drawings[name]}
    </svg>
  );
}
