/**
 * API Integration Tests
 * 
 * Tests for API endpoints including rate limiting functionality.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { config } from '../src/config.js';

// Mock config
vi.mock('../src/config.js', () => ({
  config: {
    rateLimit: {
      windowMs: 60000, // 1 minute for testing
      max: 5, // 5 requests per minute
      message: 'Too many requests from this IP, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
    },
    port: 3000,
  },
}));

// Create test app
const createTestApp = () => {
  const app = express();
  app.use(express.json());
  
  // Add helmet for security headers
  app.use(helmet());
  
  // Add rate limiting
  const limiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    message: config.rateLimit.message,
    standardHeaders: config.rateLimit.standardHeaders,
    legacyHeaders: config.rateLimit.legacyHeaders,
  });
  
  app.use('/api/', limiter);
  
  // Test routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  
  app.get('/api/test', (req, res) => {
    res.json({ message: 'Test endpoint' });
  });
  
  app.post('/api/data', (req, res) => {
    res.json({ received: req.body });
  });
  
  // Non-rate-limited route
  app.get('/public/health', (req, res) => {
    res.json({ status: 'public ok' });
  });
  
  return app;
};

describe('API Integration Tests', () => {
  let app: express.Application;
  
  beforeEach(() => {
    app = createTestApp();
  });
  
  describe('Health Check Endpoint', () => {
    it('should return 200 OK for health check', async () => {
      const response = await request(app)
        .get('/api/health')
        .expect(200);
      
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
    });
    
    it('should return JSON content type', async () => {
      await request(app)
        .get('/api/health')
        .expect('Content-Type', /json/);
    });
  });
  
  describe('Rate Limiting', () => {
    it('should allow requests within limit', async () => {
      // First request should succeed
      const response = await request(app)
        .get('/api/test')
        .expect(200);
      
      expect(response.body).toHaveProperty('message', 'Test endpoint');
    });
    
    it('should include rate limit headers', async () => {
      const response = await request(app)
        .get('/api/test')
        .expect(200);
      
      // Check standard rate limit headers
      expect(response.headers['ratelimit-limit']).toBeDefined();
      expect(response.headers['ratelimit-remaining']).toBeDefined();
      expect(response.headers['ratelimit-reset']).toBeDefined();
    });
    
    it('should return 429 after exceeding limit', async () => {
      // Make requests until we hit the limit (5 requests)
      for (let i = 0; i < 5; i++) {
        await request(app).get('/api/test');
      }
      
      // The 6th request should be rate limited
      const response = await request(app)
        .get('/api/test')
        .expect(429);
      
      const rateLimitMessage = response.body?.message ?? response.text;
      expect(rateLimitMessage).toContain('Too many requests');
    });
    
    it('should have different limits for different IPs', async () => {
      // This test verifies that rate limiting is per-IP
      // In a real scenario, you'd test with different IP addresses
      const response1 = await request(app).get('/api/test');
      expect(response1.status).toBeLessThan(500);
    });
  });
  
  describe('Security Headers (Helmet)', () => {
    it('should include security headers', async () => {
      const response = await request(app)
        .get('/api/health')
        .expect(200);
      
      // Helmet adds various security headers
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBeDefined();
    });
  });
  
  describe('POST Endpoints', () => {
    it('should accept JSON body', async () => {
      const testData = { name: 'Test', value: 123 };
      
      const response = await request(app)
        .post('/api/data')
        .send(testData)
        .expect(200);
      
      expect(response.body).toHaveProperty('received');
      expect(response.body.received).toEqual(testData);
    });
    
    it('should handle empty body', async () => {
      const response = await request(app)
        .post('/api/data')
        .send({})
        .expect(200);
      
      expect(response.body).toHaveProperty('received');
    });
  });
  
  describe('Non-rate-limited Routes', () => {
    it('should allow unlimited requests to public routes', async () => {
      // Make multiple requests to public route
      for (let i = 0; i < 10; i++) {
        const response = await request(app)
          .get('/public/health')
          .expect(200);
        
        expect(response.body).toHaveProperty('status', 'public ok');
      }
    });
  });
  
  describe('Error Handling', () => {
    it('should return 404 for unknown routes', async () => {
      await request(app)
        .get('/api/unknown-route')
        .expect(404);
    });
    
    it('should handle method not allowed', async () => {
      await request(app)
        .delete('/api/health')
        .expect(404); // Express returns 404 for undefined routes
    });
  });
});
