/**
 * 头像上传模块
 * 处理 base64 图片上传、旧文件清理、config.json 更新
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';

let logFileName = null;

export function setAvatarLogFileName(name) {
  logFileName = name;
}

/** 支持的图片类型映射 */
const EXT_MAP = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/**
 * 处理头像上传
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {string} fieldName - 字段名 ('avatar' 或 'userAvatar')
 * @param {string} agentsDir - agents 目录路径
 * @param {Map} agentsMap - pm.agents Map（用于同步 ProcessManager 中的 config）
 */
export function handleAvatarUpload(req, res, fieldName, agentsDir, agentsMap) {
  const id = req.params.id;
  const { data, type } = req.body || {};

  if (!data || !type) {
    return res.status(400).json({ error: 'Missing data or type' });
  }

  const ext = EXT_MAP[type];
  if (!ext) {
    return res.status(400).json({ error: 'Unsupported image type, use png/jpg/gif/webp' });
  }

  // 解码 base64
  const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  const configDir = path.join(agentsDir, id, 'config');
  const filename = fieldName === 'avatar' ? `avatar.${ext}` : `user_avatar.${ext}`;
  const filePath = path.join(configDir, filename);

  try {
    // 删除旧头像（不同扩展名的）
    for (const oldExt of ['png', 'jpg', 'gif', 'webp']) {
      const oldFile = path.join(configDir, fieldName === 'avatar' ? `avatar.${oldExt}` : `user_avatar.${oldExt}`);
      if (oldFile !== filePath && fs.existsSync(oldFile)) {
        fs.unlinkSync(oldFile);
      }
    }

    fs.writeFileSync(filePath, buffer);

    // 更新 config.json 中的字段
    const configPath = path.join(configDir, 'config.json');
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    existing[fieldName] = filename;
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');

    // 同步 ProcessManager
    const agentData = agentsMap.get(id);
    if (agentData) {
      agentData.config = existing;
    }

    res.json({ status: 'ok', path: `/agents/${id}/config/${filename}` });
  } catch (err) {
    const logger = createLogger('avatar', logFileName);
    logger.error(`头像上传失败: ${err.message}`);
    res.status(500).json({ error: `Failed to save avatar: ${err.message}` });
  }
}