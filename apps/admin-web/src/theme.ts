import type { GlobalThemeOverrides } from 'naive-ui';

/**
 * Maps coarse design tokens onto Naive UI so its components share the same
 * sky-blue/mint language instead of looking bolted on.
 * Button fills use the deeper blue so white label text stays >= 4.5:1.
 */
export const cozyThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#4D9DE0',
    primaryColorHover: '#267DBF',
    primaryColorPressed: '#1E6BA6',
    primaryColorSuppl: '#267DBF',
    infoColor: '#4D9DE0',
    successColor: '#2F9D82',
    warningColor: '#B4823A',
    errorColor: '#C4485C',
    textColorBase: '#233B50',
    textColor1: '#233B50',
    textColor2: '#3C5568',
    textColor3: '#637D90',
    borderColor: '#DCEBF4',
    dividerColor: '#E7F1F8',
    bodyColor: '#F6FAFF',
    cardColor: '#FFFFFF',
    modalColor: '#FFFFFF',
    popoverColor: '#FFFFFF',
    tableHeaderColor: '#EAF5FF',
    hoverColor: '#F2F9FF',
    borderRadius: '10px',
    borderRadiusSmall: '8px',
    fontSize: '14px',
    fontFamily:
      "'Inter', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif",
    fontFamilyMono: "'JetBrains Mono', 'SFMono-Regular', ui-monospace, Consolas, monospace",
  },
  Button: { borderRadiusMedium: '10px', borderRadiusLarge: '12px', fontWeight: '600' },
  Input: { borderRadius: '10px', heightMedium: '38px' },
  Select: { peers: { InternalSelection: { borderRadius: '10px', heightMedium: '38px' } } },
  DataTable: { thColor: '#EAF5FF', thTextColor: '#233B50', borderColor: '#E7F1F8' },
  Card: { borderRadius: '16px', paddingMedium: '20px 22px' },
  Modal: { borderRadius: '16px' },
  Tag: { borderRadius: '999px' },
  Pagination: { itemBorderRadius: '8px' },
  Tooltip: { borderRadius: '8px' },
  Message: { borderRadius: '12px' },
};
