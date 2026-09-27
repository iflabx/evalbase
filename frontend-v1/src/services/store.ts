/**
 * 数据服务层（Mock 实现）
 * 页面组件只依赖这些异步接口，后续可整体替换为真实后端 API。
 */
import {
  datasets,
  datasetVersions,
  evaluatedVersions,
  experiments,
  importJobs,
  initialRuns,
  langfuseProjects,
  publishJobs,
} from "./mock/data";
import type {
  CalcRun,
  Dataset,
  DatasetVersion,
  EvaluatedResultVersion,
  ImportJob,
  LangfuseExperiment,
  LangfuseProject,
  PublishJob,
} from "@/types";

export const db = {
  datasets: [...datasets],
  datasetVersions: [...datasetVersions],
  publishJobs: [...publishJobs],
  langfuseProjects: [...langfuseProjects],
  experiments: [...experiments],
  importJobs: [...importJobs],
  evaluatedVersions: [...evaluatedVersions],
  runs: [...initialRuns] as CalcRun[],
};

export type Db = typeof db;
export type {
  CalcRun,
  Dataset,
  DatasetVersion,
  EvaluatedResultVersion,
  ImportJob,
  LangfuseExperiment,
  LangfuseProject,
  PublishJob,
};

export function delay<T>(value: T, ms = 450): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export function fail(message: string, ms = 400): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

export function nowIso() {
  return new Date().toISOString();
}

export function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 演示用故障注入：便于验证失败态 UI */
export const faultInjection = {
  datasetsListFails: false,
};
