export interface AccountView {
  id: string;
  username: string;
  loginName: string;
  email: string | null;
  status: 'active' | 'banned';
  twoFactorEnabled: boolean;
  createdAt: string;
  links: Array<{ uuid: string; username: string; status: string; linkedAt: string }>;
}
