export interface UserRow {
  id: string;
  display_name: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface CmsUserInput {
  id: string;
  displayName: string;
  enabled?: boolean;
}

export interface CmsUser extends CmsUserInput {
  enabled: boolean;
  projectKeys: string[];
  createdAt: string;
  updatedAt: string;
}
