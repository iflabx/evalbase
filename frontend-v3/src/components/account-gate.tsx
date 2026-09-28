import { useState, type FormEvent } from "react";
import { Activity } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { createAdministrator, login, registerAccount } from "@/services/account";
import { resetWorkspaceSession } from "@/services/workspace";

type Mode = "login" | "register" | "setup";
const loginEmailKey = "evalbase:login-email";
const errors: Record<string, string> = {
  invalid_credentials: "邮箱或密码不正确。",
  email_already_registered: "该邮箱已注册，请返回登录。",
  installation_already_initialized: "管理员已创建，请登录。",
  administrator_setup_required: "请先创建管理员账号。",
  account_payload_invalid: "请检查邮箱、密码和确认密码。",
};

export function AccountGate({ setup }: { setup: boolean }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>(setup ? "setup" : "login");
  const activeMode = setup ? "setup" : mode;
  const [name, setName] = useState("");
  const [email, setEmail] = useState(() => sessionStorage.getItem(loginEmailKey) ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const registering = activeMode !== "login";
  const passwordHint =
    password.length === 0
      ? "至少 8 个字符；字母、数字和符号均可。"
      : password.length >= 8
        ? "密码长度符合要求。"
        : "密码至少需要 8 个字符。";
  const confirmHint =
    confirm.length === 0
      ? "请再次输入相同密码。"
      : confirm === password
        ? "两次输入的密码相同。"
        : "两次输入的密码不一致。";
  const valid =
    email.trim() &&
    password &&
    (!registering ||
      (password.length >= 8 && confirm === password && (activeMode !== "setup" || name.trim())));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (registering && password !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    try {
      if (activeMode === "setup") {
        await createAdministrator({
          displayName: name.trim(),
          email: email.trim(),
          password,
          confirmPassword: confirm,
        });
        await queryClient.invalidateQueries({ queryKey: ["installation"] });
        setMode("login");
        setPassword("");
        setConfirm("");
      } else if (activeMode === "register") {
        await registerAccount({ email: email.trim(), password, confirmPassword: confirm });
        try {
          await login(email.trim(), password);
          sessionStorage.removeItem(loginEmailKey);
          resetWorkspaceSession();
          await queryClient.invalidateQueries({ queryKey: ["session"] });
        } catch {
          setMode("login");
          setPassword("");
          setConfirm("");
          setError("账号已注册，请登录。");
        }
      } else {
        await login(email.trim(), password);
        sessionStorage.removeItem(loginEmailKey);
        resetWorkspaceSession();
        await queryClient.invalidateQueries({ queryKey: ["session"] });
      }
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(errors[code] ?? "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <header className="auth-top">
        <div className="auth-brand">
          <span className="auth-brand-mark">
            <Activity size={17} />
          </span>
          <span>
            <strong>EvalBase</strong>
            <small>团队测试资料库</small>
          </span>
        </div>
      </header>
      <div className="auth-main">
        <section className="auth-card">
          <h1>
            {activeMode === "setup"
              ? "管理员注册"
              : activeMode === "register"
                ? "账号注册"
                : "登录 EvalBase"}
          </h1>
          <p className="auth-intro">
            {activeMode === "setup"
              ? "首次访问时创建管理员账号。完成后即可管理项目与邀请成员。"
              : activeMode === "register"
                ? "填写邮箱并设置密码。注册后进入项目列表；接受管理员发给该邮箱的邀请后即可访问项目。"
                : "进入你有权访问的项目，管理数据集与测试集。"}
          </p>
          <form className="auth-form" onSubmit={submit}>
            {activeMode === "setup" && (
              <label>
                显示名称
                <input
                  autoComplete="name"
                  maxLength={30}
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            <label>
              邮箱
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  sessionStorage.setItem(loginEmailKey, event.target.value);
                }}
              />
            </label>
            <label>
              密码
              <input
                type="password"
                autoComplete={registering ? "new-password" : "current-password"}
                required
                minLength={registering ? 8 : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {registering && (
                <small
                  className={`password-hint ${password ? (password.length >= 8 ? "is-valid" : "is-invalid") : ""}`}
                  aria-live="polite"
                >
                  {passwordHint}
                </small>
              )}
            </label>
            {registering && (
              <label>
                确认密码
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
                <small
                  className={`password-hint ${confirm ? (confirm === password ? "is-valid" : "is-invalid") : ""}`}
                  aria-live="polite"
                >
                  {confirmHint}
                </small>
              </label>
            )}
            <button className="auth-primary" type="submit" disabled={busy || !valid}>
              {busy
                ? "处理中…"
                : activeMode === "setup"
                  ? "创建管理员账号"
                  : activeMode === "register"
                    ? "注册账号"
                    : "登录"}
            </button>
          </form>
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          {activeMode === "login" && (
            <div className="auth-entry-guide">
              <b>还没有账号？</b>
              <p>可自行注册账号；加入项目仍需管理员邀请注册时使用的邮箱。</p>
              <button
                type="button"
                onClick={() => {
                  setMode("register");
                  setError("");
                }}
              >
                账号注册 →
              </button>
            </div>
          )}
          {activeMode === "register" && (
            <button
              className="auth-back"
              type="button"
              onClick={() => {
                setMode("login");
                setError("");
              }}
            >
              返回登录
            </button>
          )}
        </section>
      </div>
    </main>
  );
}
