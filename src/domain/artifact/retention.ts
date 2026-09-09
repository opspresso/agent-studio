export interface FileRetention {
  unit: "days" | "months";
  value: number;
  timezone: string;
}
