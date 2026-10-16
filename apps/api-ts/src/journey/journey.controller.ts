import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CitizenId } from "../common/citizen-id.decorator.js";
import { InternalServiceGuard } from "../common/internal-service.guard.js";
import { JourneyService } from "./journey.service.js";

@Controller("journey")
export class JourneyController {
  constructor(
    @Inject(JourneyService) private readonly journey: JourneyService,
  ) {}
  @Get("proposals/:id")
  package(
    @Param("id", ParseUUIDPipe) id: string,
    @CitizenId() citizenId?: string,
  ) {
    return this.journey.package(id, citizenId);
  }
  @Post("sessions/:id/reconcile")
  @UseGuards(InternalServiceGuard)
  reconcile(@Param("id", ParseUUIDPipe) id: string) {
    return this.journey.reconcile(id);
  }
}
