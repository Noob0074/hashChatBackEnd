import { Resend } from "resend";

// We'll initialize this lazily to prevent crashing if the API key is missing on startup
let resend;

/**
 * Send a verification email to the user using Resend.com
 * @param {string} email - Recipient email
 * @param {string} token - Verification token
 */
export const sendVerificationEmail = async (email, token) => {
  const verifyUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/verify?token=${token}`;

  try {
    // If no API key is provided, log to console instead (stub mode)
    if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === "re_123456789") {
      console.log("═══════════════════════════════════════════════");
      console.log("📧 VERIFICATION EMAIL (stub — check .env for API key)");
      console.log(`   To: ${email}`);
      console.log(`   Verify URL: ${verifyUrl}`);
      console.log("═══════════════════════════════════════════════");
      return true;
    }

    if (!resend && process.env.RESEND_API_KEY) {
      resend = new Resend(process.env.RESEND_API_KEY);
    }

    const { data, error: resendError } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev",
      to: email,
      subject: "Verify your HashChat account",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #0f172a; color: #f8fafc; border-radius: 16px;">
          <h2 style="color: #6366f1; text-align: center;">Welcome to HashChat!</h2>
          <p style="font-size: 16px; line-height: 1.5; text-align: center;">
            You're just one step away from joining the anonymous community. 
            Please verify your email address by clicking the button below:
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verifyUrl}" 
               style="display: inline-block; padding: 14px 28px; background-color: #6366f1; color: white; text-decoration: none; border-radius: 10px; font-weight: bold; font-size: 16px;">
              Verify My Email
            </a>
          </div>
          <p style="color: #94a3b8; font-size: 14px; text-align: center;">
            Or copy and paste this link in your browser: <br/>
            <span style="color: #6366f1; word-break: break-all;">${verifyUrl}</span>
          </p>
          <hr style="border: 0; border-top: 1px solid #334155; margin: 30px 0;" />
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            This link will expire in ${process.env.AUTH_EMAIL_EXPIRY_HRS || "24"} hours. If you didn't create an account, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    if (resendError) {
      console.error(`❌ Resend Error [Verification]:`, resendError);
      return false;
    }

    console.log(`✅ Verification email sent to ${email} (ID: ${data.id})`);
    return true;
  } catch (error) {
    console.error(`❌ Unexpected Failure sending verification email to ${email}:`, error);
    return false;
  }
};

/**
 * Send a password reset email to the user using Resend.com
 * @param {string} email - Recipient email
 * @param {string} token - Reset token
 */
export const sendPasswordResetEmail = async (email, token) => {
  const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/reset-password?token=${token}`;

  try {
    if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === "re_123456789") {
      console.log("═══════════════════════════════════════════════");
      console.log("📧 PASSWORD RESET EMAIL (stub)");
      console.log(`   To: ${email}`);
      console.log(`   Reset URL: ${resetUrl}`);
      console.log("═══════════════════════════════════════════════");
      return true;
    }

    if (!resend && process.env.RESEND_API_KEY) {
      resend = new Resend(process.env.RESEND_API_KEY);
    }

    const { data, error: resendError } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev",
      to: email,
      subject: "Reset your HashChat password",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #0f172a; color: #f8fafc; border-radius: 16px;">
          <h2 style="color: #6366f1; text-align: center;">Reset Your Password</h2>
          <p style="font-size: 16px; line-height: 1.5; text-align: center;">
            No worries, it happens! Click the button below to reset your password and get back to chatting.
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" 
               style="display: inline-block; padding: 14px 28px; background-color: #ef4444; color: white; text-decoration: none; border-radius: 10px; font-weight: bold; font-size: 16px;">
              Reset Password
            </a>
          </div>
          <p style="color: #94a3b8; font-size: 14px; text-align: center;">
            Or copy and paste this link in your browser: <br/>
            <span style="color: #6366f1; word-break: break-all;">${resetUrl}</span>
          </p>
          <hr style="border: 0; border-top: 1px solid #334155; margin: 30px 0;" />
          <p style="color: #64748b; font-size: 12px; text-align: center;">
            This link is valid for ${process.env.AUTH_PASSWORD_RESET_EXPIRY_HRS || "1"} hour(s). If you didn't request a password reset, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    if (resendError) {
      console.error(`❌ Resend Error [Password Reset]:`, resendError);
      return false;
    }

    console.log(`✅ Password reset email sent to ${email} (ID: ${data.id})`);
    return true;
  } catch (error) {
    console.error(`❌ Unexpected Failure sending reset email to ${email}:`, error);
    return false;
  }
};
