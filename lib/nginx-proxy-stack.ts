import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export class NginxProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, {
      env: {
        region: "ap-southeast-1",
      },
      ...props,
    });

    // Create VPC
    const vpc = new ec2.Vpc(this, "NginxVpc", {
      maxAzs: 2, // Ensures redundancy across availability zones
      natGateways: 0,
    });

    // Security group for ALB
    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc,
      description: "Security group for ALB",
      allowAllOutbound: true,
    });

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP traffic"
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow HTTPS traffic"
    );

    // Security group for EC2 instances
    const ec2SecurityGroup = new ec2.SecurityGroup(this, "NginxSecurityGroup", {
      vpc,
      description: "Security group for Nginx instances",
      allowAllOutbound: true,
    });

    // Allow ALB to communicate with EC2 instances
    ec2SecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),
      ec2.Port.tcp(80),
      "Allow HTTP traffic from ALB"
    );

    // Allow SSH Access
    ec2SecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(), // Replace with your IP if needed
      ec2.Port.tcp(22),
      "Allow SSH access"
    );

    // Create ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, "NginxAlb", {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
    });

    // Create ACM certificate
    const certificate = new acm.Certificate(this, "NginxCertificate", {
      domainName: "*.bim.com.sg",
      validation: acm.CertificateValidation.fromDns(),
    });

    // User data script for Nginx setup
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "sudo apt-get update -y",
      "sudo apt-get install -y nginx",
      `sudo bash -c 'cat > /etc/nginx/sites-available/default <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location / {
        proxy_pass https://www.bim.com.sg;
        proxy_set_header Host www.bim.com.sg;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_ssl_server_name on;
    }

    location /_next/ {
        proxy_pass https://jobs.bimeco.io/_next/;
        proxy_set_header Host jobs.bimeco.io;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_ssl_server_name on;
    }

    location /career {
        proxy_pass https://jobs.bimeco.io;
        proxy_set_header Host jobs.bimeco.io;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_ssl_server_name on;
        proxy_redirect https://jobs.bimeco.io/career/ /jobs/;
        proxy_connect_timeout 60s;
        proxy_read_timeout 60s;
    }

    location /health {
        access_log off;
        return 200 'Healthy';
    }

    error_page 404 /404.html;
    error_page 500 502 503 504 /50x.html;
    location = /50x.html {
        root /usr/share/nginx/html;
    }
}
EOF'`,
      "sudo nginx -t",
      "sudo systemctl restart nginx",
      "sudo systemctl enable nginx"
    );

    // Define a Launch Template for EC2 instances
    const launchTemplate = new ec2.LaunchTemplate(this, "NginxLaunchTemplate", {
      machineImage: ec2.MachineImage.genericLinux({
        "ap-southeast-1": "ami-0672fd5b9210aa093",
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T2,
        ec2.InstanceSize.MICRO
      ),
      keyName: "default-bim",
      securityGroup: ec2SecurityGroup,
      userData,
    });

    // Create an Auto Scaling Group
    const autoScalingGroup = new autoscaling.AutoScalingGroup(
      this,
      "NginxAsg",
      {
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        minCapacity: 3, // Ensures at least 3 instances
        maxCapacity: 4, // Can scale up if needed
        launchTemplate,
        healthCheck: autoscaling.HealthCheck.elb({
          grace: cdk.Duration.minutes(30),
        }),
      }
    );

    // Create target group for ALB
    const targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "NginxTargetGroup",
      {
        vpc,
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [autoScalingGroup],
        targetType: elbv2.TargetType.INSTANCE,
        healthCheck: {
          path: "/health",
          healthyHttpCodes: "200-399",
        },
      }
    );

    // Create ALB listeners
    alb.addRedirect(); // Redirect HTTP to HTTPS

    alb.addListener("HttpsListener", {
      port: 443,
      defaultAction: elbv2.ListenerAction.forward([targetGroup]),
      certificates: [
        elbv2.ListenerCertificate.fromCertificateManager(certificate),
      ],
    });

    // Output the ALB DNS name
    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "DNS name of the load balancer",
    });
  }
}
