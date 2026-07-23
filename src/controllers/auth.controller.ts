import crypto from "crypto";
import { Request, Response } from "express";
import { User } from "../models/User";
import { signUserToken, verifyPassword } from "../services/auth.service";
import { sendEmail } from "../services/resend.service";
import { AuthRequest } from "../types/AuthRequest";
import { getFrontendUrl } from "../config/env";

function loginButtonHtml(frontendUrl: string) {
  return `
    <div style="text-align:center;margin:0 0 20px">
      <a href="${frontendUrl}/login" style="display:inline-block;background:#235931;color:#fff;padding:14px 28px;border-radius:999px;font-size:15px;font-weight:800;text-decoration:none">Iniciar sesión</a>
    </div>`;
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body as { email: string; password: string };
  const user = await User.findOne({ email: email.toLowerCase() }).select("+password").populate("branches");
  if (!user) {
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }

  const ok = await verifyPassword(password, user.password);
  if (!ok) {
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }

  const token = signUserToken({
    userId: String(user._id),
    email: user.email,
    accountType: user.accountType,
    branches: user.branches.map((branch: any) => String(branch._id || branch)),
    allBranches: user.allBranches,
  });
  const safeUser = await User.findById(user._id).select("-password").populate("branches");
  res.json({ token, user: safeUser });
}

export async function register(req: Request, res: Response) {
  const user = await User.create(req.body);
  const token = signUserToken({
    userId: String(user._id),
    email: user.email,
    accountType: user.accountType,
    branches: user.branches.map((branch: any) => String(branch._id || branch)),
    allBranches: user.allBranches,
  });
  const safeUser = await User.findById(user._id).select("-password").populate("branches");
  res.status(201).json({ token, user: safeUser });
}

export async function me(req: AuthRequest, res: Response) {
  const userId = req.user?.userId;
  const user = await User.findById(userId).select("-password").populate("branches");
  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  res.json(user);
}

export async function forgotPassword(req: Request, res: Response) {
  const { email } = req.body as { email: string };
  if (!email) {
    res.status(400).json({ message: "Email es requerido" });
    return;
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    res.json({ message: "Si el correo existe, recibirás un enlace para restablecer tu contraseña" });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  user.resetPasswordToken = token;
  user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
  await user.save();

  const origin = req.headers.origin;
  const frontendUrl = origin && origin !== "null" ? origin : getFrontendUrl();
  const resetLink = `${frontendUrl}/reset-password?token=${token}&email=${encodeURIComponent(user.email)}`;

  const html = `
    <div style="font-family:Switzer,-apple-system,sans-serif;max-width:480px;margin:0 auto">
      <div style="background:#235931;padding:24px;border-radius:16px 16px 0 0;text-align:center">
        <h1 style="color:#fff;margin:0;font-size:22px">Boloncity</h1>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 16px 16px">
        <p style="font-size:18px;font-weight:700;margin:0 0 12px">Restablece tu contraseña</p>
        <p style="color:#666;margin:0 0 20px">Recibimos una solicitud para restablecer la contraseña de tu cuenta en Boloncity. Haz clic en el botón para crear una nueva contraseña.</p>
        <div style="text-align:center;margin:0 0 20px">
          <a href="${resetLink}" style="display:inline-block;background:#235931;color:#fff;padding:14px 28px;border-radius:999px;font-size:15px;font-weight:800;text-decoration:none">Restablecer contraseña</a>
        </div>
        <p style="color:#999;font-size:13px">Si no solicitaste esto, ignora este correo. El enlace expira en 1 hora.</p>
      </div>
    </div>`;

  await sendEmail(user.email, "Restablece tu contraseña — Boloncity", html);

  res.json({ message: "Si el correo existe, recibirás un enlace para restablecer tu contraseña" });
}

export async function resetPassword(req: Request, res: Response) {
  const { token, email, password } = req.body as { token: string; email: string; password: string };

  if (!token || !email || !password) {
    res.status(400).json({ message: "Token, email y contraseña son requeridos" });
    return;
  }

  const user = await User.findOne({
    email: email.toLowerCase(),
    resetPasswordToken: token,
    resetPasswordExpires: { $gt: new Date() },
  }).select("+password");

  if (!user) {
    res.status(400).json({ message: "El enlace ha expirado o no es válido. Solicita un nuevo restablecimiento." });
    return;
  }

  user.password = password;
  user.resetPasswordToken = null;
  user.resetPasswordExpires = null;
  await user.save();

  const frontendUrl = getFrontendUrl();
  const html = `
    <div style="font-family:Switzer,-apple-system,sans-serif;max-width:480px;margin:0 auto">
      <div style="background:#235931;padding:24px;border-radius:16px 16px 0 0;text-align:center">
        <h1 style="color:#fff;margin:0;font-size:22px">Boloncity</h1>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 16px 16px">
        <p style="font-size:18px;font-weight:700;margin:0 0 12px">Contraseña actualizada</p>
        <p style="color:#666;margin:0 0 20px">Tu contraseña se ha restablecido exitosamente. Ya puedes iniciar sesión con tu nueva contraseña.</p>
        ${loginButtonHtml(frontendUrl)}
      </div>
    </div>`;

  await sendEmail(user.email, "Tu contraseña ha sido actualizada — Boloncity", html).catch(() => {});

  res.json({ message: "Contraseña actualizada exitosamente. Ahora puedes iniciar sesión con tu nueva contraseña." });
}
