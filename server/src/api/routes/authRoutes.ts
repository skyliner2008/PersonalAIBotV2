import { Router, Request } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { validateBody } from '../../utils/validation.js';
import { login as authLogin, requireAuth } from '../../utils/auth.js';

const authLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const authRoutes = Router();
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5, // Limit each IP to 5 requests per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 5 minutes and try again.' },
});

authRoutes.post('/auth/login', loginLimiter, validateBody(authLoginSchema), async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await authLogin(username, password);
    if (!result) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    res.json(result);
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a custom request interface
interface CustomRequest extends Request {
  user?: {
    username: string;
    role: 'admin' | 'viewer';
  };
}

authRoutes.get('/auth/me', requireAuth(), (req: CustomRequest, res) => {
  res.json({ user: req.user });
});

export default authRoutes;
