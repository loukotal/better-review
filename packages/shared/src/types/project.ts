export interface ProjectSummary {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  owner: {
    login: string;
    type: string;
  };
}

export interface ProjectStatusOption {
  id: string;
  name: string;
}

export interface ProjectStatusField {
  id: string;
  key: string;
  name: string;
  options: ProjectStatusOption[];
}

export interface ProjectBoardItem {
  id: string;
  status: string | null;
  assignees: string[];
  content: {
    type: string;
    title: string;
    body: string | null;
    url: string | null;
    number: number | null;
    repository: string | null;
  } | null;
}

export interface ProjectBoardColumn {
  id: string | null;
  name: string;
  items: ProjectBoardItem[];
}

export interface ProjectBoard {
  project: ProjectSummary;
  statusField: ProjectStatusField | null;
  columns: ProjectBoardColumn[];
  totalCount: number;
}
