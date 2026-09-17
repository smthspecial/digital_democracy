import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { register } from "./metrics.js";

@Controller()
export class MetricsController {
  @Get("metrics")
  async metrics(@Res() res: Response): Promise<void> {
    res.setHeader("Content-Type", register.contentType);
    res.send(await register.metrics());
  }
}
