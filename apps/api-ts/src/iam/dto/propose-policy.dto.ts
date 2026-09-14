import { IsArray, IsIn, IsObject, IsOptional, IsString, Length } from "class-validator";

export class ProposePolicyDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsIn(["allow", "deny"])
  effect!: "allow" | "deny";

  @IsArray()
  @IsString({ each: true })
  actions!: string[];

  @IsArray()
  @IsString({ each: true })
  resources!: string[];

  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown>;

  @IsString()
  @Length(1, 2000)
  description!: string;
}
