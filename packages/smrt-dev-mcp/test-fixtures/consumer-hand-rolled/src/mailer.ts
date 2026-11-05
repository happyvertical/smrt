import nodemailer from 'nodemailer';

const transport = nodemailer.createTransport({ host: 'smtp.example.test' });

export async function sendWelcome(to: string) {
  await transport.sendMail({ to, subject: 'Welcome' });
}
